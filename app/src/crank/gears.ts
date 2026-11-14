import type { Address, Hex } from "viem";
import { IODGearAbi, IODGearRegistryAbi, IODMinterAbi } from "../abi";
import type { CrankContext } from "./context";

export const MULTICALL_CHUNK = 200;

export const contractAddress = (context: Pick<CrankContext, "deployment">, name: string): Address => {
  const address = context.deployment.contracts[name];
  if (!address) throw new Error(`Deployment has no ${name} address`);
  return address as Address;
};

/** Runs `calls` through multicall in chunks, results in order. allowFailure is false: a crank must not act on half a picture. */
export async function chunkedMulticall(context: Pick<CrankContext, "clients">, calls: readonly unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let offset = 0; offset < calls.length; offset += MULTICALL_CHUNK) {
    const part = await context.clients.stateClient.multicall({ contracts: calls.slice(offset, offset + MULTICALL_CHUNK) as never, allowFailure: false });
    results.push(...(part as unknown[]));
  }
  return results;
}

export interface ChainGear {
  id: Hex;
  marketA: Hex;
  marketB: Hex;
  token: Address;
  /** GearStatus: 0 NONE, 1 LISTED, 2 BUYS_PAUSED, 3 SELL_ONLY, 4 SETTLED */
  status: number;
  nf: bigint;
  lastAccrual: bigint;
  supply: bigint;
}

const ZERO_ID = `0x${"0".repeat(64)}`;

/** Reads every listed gear straight from the registry (the chain is the truth; the indexer may lag a block or two behind a
 * listing). Ids are append-only, so known ids are never re-enumerated. `supply` is read only when asked for. */
export function createGearReader(context: Pick<CrankContext, "clients" | "deployment">) {
  const registry = contractAddress(context, "ODGearRegistry");
  const minter = contractAddress(context, "ODMinter");
  const ids: Hex[] = [];
  return {
    async readAll(options: { supplyFor?: (gear: Omit<ChainGear, "supply">) => boolean } = {}): Promise<ChainGear[]> {
      const count = Number(await context.clients.stateClient.readContract({ address: registry, abi: IODGearRegistryAbi, functionName: "gearCount" }));
      if (count > ids.length) {
        const fresh = await chunkedMulticall(context, Array.from({ length: count - ids.length }, (_, i) => ({
          address: registry, abi: IODGearRegistryAbi, functionName: "gearIdAt", args: [BigInt(ids.length + i)],
        })));
        ids.push(...(fresh as Hex[]));
      }
      if (!ids.length) return [];
      const rows = await chunkedMulticall(context, ids.flatMap((id) => [
        { address: registry, abi: IODGearRegistryAbi, functionName: "gear", args: [id] },
        { address: minter, abi: IODMinterAbi, functionName: "normState", args: [id] },
      ]));
      const base = ids.map((id, i) => {
        const row = rows[i * 2] as { marketA: Hex; marketB: Hex; token: Address; status: number };
        const norm = rows[i * 2 + 1] as { nf: bigint; lastAccrual: bigint };
        return { id, marketA: row.marketA, marketB: row.marketB, token: row.token.toLowerCase() as Address, status: Number(row.status), nf: BigInt(norm.nf), lastAccrual: BigInt(norm.lastAccrual) };
      });
      const wanted = base.filter((gear) => (options.supplyFor ? options.supplyFor(gear) : true));
      const supplies = wanted.length
        ? await chunkedMulticall(context, wanted.map((gear) => ({ address: gear.token, abi: IODGearAbi, functionName: "totalSupply" })))
        : [];
      const bySupply = new Map(wanted.map((gear, i) => [gear.id, BigInt(supplies[i] as bigint)]));
      return base.map((gear) => ({ ...gear, supply: bySupply.get(gear.id) ?? 0n }));
    },
  };
}

/** Markets of the deployment that follow the NYSE calendar (not alwaysOpen). */
export const sessionMarkets = (deployment: Pick<CrankContext, "deployment">["deployment"]) => deployment.markets.filter((m) => !m.alwaysOpen);
export const isSessionGear = (deployment: CrankContext["deployment"], gear: Pick<ChainGear, "marketA" | "marketB">): boolean => {
  const open = new Set(sessionMarkets(deployment).map((m) => m.id.toLowerCase()));
  return open.has(gear.marketA.toLowerCase()) || (gear.marketB !== ZERO_ID && open.has(gear.marketB.toLowerCase()));
};
