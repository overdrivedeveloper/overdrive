// Brings a deployment record's `markets` and `gears` level with the chain (read-only eth_calls, no key, nothing sent).
// Run it after the list-gears batch executes through the timelock, then commit the record, regenerate the README section
// and the SDK table, and redeploy the services.
//
//   bun app/scripts/deploy/record-sync.ts <record.json> [--rpc URL] [--check] [--out FILE]
//
// --check exits 1 and names every gear or market the record lacks or gets wrong; without it the record is rewritten
// (or written to --out). The RPC defaults to the public Robinhood Chain endpoint of the record's network.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { IODGearRegistryAbi, IODHookAbi, IODOracleGuardAbi } from "../../src/abi";
import { parseDeployment } from "../../src/lib/deployments";
import { recordDrift, syncRecord, type RecordChain } from "../../src/lib/record-sync";

const RPC: Record<string, string> = { mainnet: "https://rpc.mainnet.chain.robinhood.com", testnet: "https://rpc.testnet.chain.robinhood.com" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) { console.error("usage: bun app/scripts/deploy/record-sync.ts <record.json> [--rpc URL] [--check] [--out FILE]"); process.exit(2); }
const record = parseDeployment(JSON.parse(readFileSync(file, "utf8")));
const rpc = arg("--rpc") ?? RPC[record.network];
if (!rpc) { console.error(`no default RPC for network ${record.network}: pass --rpc`); process.exit(2); }
const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
if (chainId !== record.chainId) { console.error(`refused: the RPC is chain ${chainId}, the record is for ${record.chainId}`); process.exit(1); }

const registry = record.contracts.ODGearRegistry as Hex;
const hook = record.contracts.ODHook as Hex;
const guard = record.contracts.ODOracleGuard as Hex;
const block = await client.getBlockNumber();
const read = <T>(address: Hex, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, blockNumber: block }) as Promise<T>;
const chain: RecordChain = {
  gearCount: () => read<bigint>(registry, IODGearRegistryAbi, "gearCount"),
  gearIdAt: (i) => read<Hex>(registry, IODGearRegistryAbi, "gearIdAt", [i]),
  gear: async (id) => {
    const g = await read<{ marketA: Hex; marketB: Hex; gear: number; token: string; unitWad: bigint; capUsdWad: bigint; spreadBps: number }>(registry, IODGearRegistryAbi, "gear", [id]);
    return { marketA: g.marketA, marketB: g.marketB, gear: Number(g.gear), token: g.token, unitWad: g.unitWad, capUsdWad: g.capUsdWad, spreadBps: Number(g.spreadBps) };
  },
  tokenSymbol: (token) => read<string>(token as Hex, erc20Abi, "symbol"),
  poolIdOf: (id) => read<Hex>(hook, IODHookAbi, "poolIdOf", [id]),
  marketConfig: async (market) => {
    const c = await read<{ feed: string; stockToken: string; multiplierEmbedded: boolean; alwaysOpen: boolean; pythId: Hex; twapPool: string }>(guard, IODOracleGuardAbi, "config", [market]);
    return { feed: c.feed, stockToken: c.stockToken, multiplierEmbedded: c.multiplierEmbedded, alwaysOpen: c.alwaysOpen, pythId: c.pythId, twapPool: c.twapPool };
  },
};

const synced = await syncRecord(record, chain);
const drift = recordDrift(record, synced);
if (process.argv.includes("--check")) {
  if (drift.length === 0) { console.log(`record-sync: ${file} agrees with chain ${chainId} at block ${block} (${synced.gears.length} gears, ${synced.markets.length} markets)`); process.exit(0); }
  for (const line of drift) console.error(`record-sync: ${line}`);
  console.error(`record-sync: FAIL, ${file} lags chain ${chainId} at block ${block}: run without --check, commit, and redeploy the services`);
  process.exit(1);
}
const out = arg("--out") ?? file;
writeFileSync(out, `${JSON.stringify(synced, null, 2)}\n`);
console.log(`record-sync: wrote ${out} from chain ${chainId} at block ${block} (${synced.gears.length} gears, ${synced.markets.length} markets; ${drift.length} change(s))`);
