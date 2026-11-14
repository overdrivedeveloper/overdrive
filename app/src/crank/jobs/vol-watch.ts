// R15 (STALE-1): warns when a sigma post goes stale; never pauses. `hardStale` (3 days past validUntil) is critical because the
// minter then pauses buys of that market; only a fresh post clears it. Posting sigma is the vol engine's job, not the crank's.
import type { Hex } from "viem";
import { IODVolOracleAbi } from "../../abi";
import { raiseAlert } from "../alerts";
import type { CrankContext } from "../context";
import { contractAddress } from "../gears";

export function createVolWatchJob(context: CrankContext) {
  const oracle = contractAddress(context, "ODVolOracle");
  /** First second a market was seen stale when the contract gives no `validUntil` to measure from. */
  const firstSeen = new Map<Hex, number>();
  return async (): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    const nowSeconds = Math.floor(nowMs / 1000);
    const warnAfter = context.config.VOL_STALE_WARN_SECONDS;
    const stale: string[] = [];
    const warned: string[] = [];
    const critical: string[] = [];
    for (const market of context.deployment.markets) {
      const read = await context.clients.stateClient.readContract({ address: oracle, abi: IODVolOracleAbi, functionName: "read", args: [market.id] }).catch(() => undefined);
      if (!read) continue;
      if (!read.stale && !read.hardStale) { firstSeen.delete(market.id); continue; }
      const since = read.validUntil > 0n ? Number(read.validUntil) : Math.floor((firstSeen.get(market.id) ?? nowMs) / 1000);
      if (!firstSeen.has(market.id)) firstSeen.set(market.id, nowMs);
      const staleFor = Math.max(0, nowSeconds - since);
      stale.push(market.symbol);
      if (read.hardStale) {
        critical.push(market.symbol);
        await raiseAlert(context, { key: `vol:hard:${market.symbol}`, level: "critical", text: `${market.symbol}: the sigma post is hard stale; buys of this market are paused until a fresh post lands` }, { quietMs: 6 * 3_600_000 });
      } else if (staleFor > warnAfter) {
        warned.push(market.symbol);
        await raiseAlert(context, { key: `vol:stale:${market.symbol}`, level: "warn", text: `${market.symbol}: the sigma post has been stale for ${Math.floor(staleFor / 60)} min (the contract prices with its floor)` }, { quietMs: 3_600_000 });
      }
    }
    return { stale, warned, critical, warnAfterSeconds: warnAfter };
  };
}
