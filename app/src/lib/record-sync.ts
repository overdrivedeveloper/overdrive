// Rebuilds the `markets` and `gears` of a deployment record from the chain (read-only). Gears are listed after the deploy,
// through the timelock, so DeploySystem writes a record without them; this is the step that brings the record level with
// the chain. Gears come from the registry in registry order with the same fields and units as DeploymentFile.sol; the
// markets those gears use come from ODOracleGuard.config. A record market no gear uses yet is kept as it is.
import { getAddress, type Hex } from "viem";
import type { Deployment } from "./deployments";
import { parseDeployment } from "./deployments";

export interface ChainGear {
  marketA: Hex; marketB: Hex; gear: number; token: string; unitWad: bigint; capUsdWad: bigint; spreadBps: number;
}
export interface ChainMarket {
  feed: string; stockToken: string; multiplierEmbedded: boolean; alwaysOpen: boolean; pythId: Hex; twapPool: string;
}
/** The chain reads the sync needs (one adapter in the script, a fake in tests). */
export interface RecordChain {
  gearCount(): Promise<bigint>;
  gearIdAt(i: bigint): Promise<Hex>;
  gear(id: Hex): Promise<ChainGear>;
  tokenSymbol(token: string): Promise<string>;
  poolIdOf(id: Hex): Promise<Hex>;
  marketConfig(market: Hex): Promise<ChainMarket>;
}

const GEAR_NAMES = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"] as const;
const GEAR_POWERS = ["1.5", "2", "3", "0.5", "-1"] as const;
const ZERO32 = `0x${"0".repeat(64)}`;
const ZERO20 = `0x${"0".repeat(40)}`;
const WAD = 10n ** 18n;

/** A market id (the symbol's ASCII right padded with zeros, SystemConfig.sol) to its symbol; throws on anything else. */
export function symbolOfMarket(id: string): string {
  const raw = Buffer.from(id.slice(2), "hex");
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  const body = raw.subarray(0, end);
  if (end === 0 || [...body].some((b) => b <= 0x20 || b >= 0x7f)) throw new Error(`market id ${id} is not an ASCII symbol`);
  return body.toString("ascii");
}

const orNull = (a: string): `0x${string}` | null => (a.toLowerCase() === ZERO20 ? null : getAddress(a));

export async function chainRecord(record: Deployment, chain: RecordChain): Promise<Pick<Deployment, "markets" | "gears">> {
  const n = await chain.gearCount();
  const gears: Deployment["gears"] = [];
  const used: Hex[] = [];
  for (let i = 0n; i < n; i++) {
    const id = (await chain.gearIdAt(i)).toLowerCase() as Hex;
    const g = await chain.gear(id);
    const marketA = g.marketA.toLowerCase() as Hex;
    const marketB = g.marketB.toLowerCase() === ZERO32 ? null : (g.marketB.toLowerCase() as Hex);
    for (const m of [marketA, marketB]) if (m && !used.includes(m)) used.push(m);
    gears.push({
      id, symbol: await chain.tokenSymbol(g.token), gear: GEAR_NAMES[g.gear]!, power: GEAR_POWERS[g.gear]!,
      marketA: symbolOfMarket(marketA), marketB: marketB ? symbolOfMarket(marketB) : null, token: getAddress(g.token),
      poolId: (await chain.poolIdOf(id)).toLowerCase() as Hex, capUsd: (g.capUsdWad / WAD).toString(), spreadBps: Number(g.spreadBps), unitUsd: (g.unitWad / WAD).toString(),
    });
  }
  const markets: Deployment["markets"] = [];
  const fromChain = async (id: Hex): Promise<Deployment["markets"][number]> => {
    const c = await chain.marketConfig(id);
    if (c.feed.toLowerCase() === ZERO20 && c.pythId.toLowerCase() === ZERO32 && c.twapPool.toLowerCase() === ZERO20) throw new Error(`market ${symbolOfMarket(id)} is used by a listed gear but has no oracle config`);
    return {
      id, symbol: symbolOfMarket(id), kind: c.stockToken.toLowerCase() === ZERO20 ? "crypto" : "stock", feed: getAddress(c.feed), stockToken: orNull(c.stockToken),
      multiplierEmbedded: c.multiplierEmbedded, pythId: c.pythId.toLowerCase() === ZERO32 ? null : (c.pythId.toLowerCase() as Hex), twapPool: orNull(c.twapPool), alwaysOpen: c.alwaysOpen,
    };
  };
  for (const m of record.markets) markets.push(used.includes(m.id.toLowerCase() as Hex) ? await fromChain(m.id.toLowerCase() as Hex) : m);
  for (const id of used) if (!markets.some((m) => m.id.toLowerCase() === id)) markets.push(await fromChain(id));
  return { markets, gears };
}

/** The record with its markets and gears taken from the chain, validated by the shared parser. */
export async function syncRecord(record: Deployment, chain: RecordChain): Promise<Deployment> {
  return parseDeployment({ ...record, ...(await chainRecord(record, chain)) });
}

/** What the record lacks or gets wrong against the chain, one line each; empty when they agree. */
export function recordDrift(record: Deployment, synced: Deployment): string[] {
  const out: string[] = [];
  const key = (x: { id: string }) => x.id.toLowerCase();
  for (const [what, have, want] of [["gear", record.gears, synced.gears], ["market", record.markets, synced.markets]] as const) {
    const byId = new Map<string, unknown>((have as readonly { id: string }[]).map((x) => [key(x), x]));
    for (const w of want as readonly { id: string; symbol: string }[]) {
      const h = byId.get(key(w));
      if (!h) out.push(`${what} ${w.symbol} (${w.id}) is on chain but missing from the record`);
      else if (JSON.stringify(h) !== JSON.stringify(w)) out.push(`${what} ${w.symbol} (${w.id}) differs from the chain`);
    }
    const wantIds = new Set((want as readonly { id: string }[]).map(key));
    if (what === "gear") for (const h of have as readonly { id: string; symbol: string }[]) if (!wantIds.has(key(h))) out.push(`gear ${h.symbol} (${h.id}) is in the record but not listed on chain`);
  }
  return out;
}
