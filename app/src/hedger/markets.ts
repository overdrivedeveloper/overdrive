// The underlyings the hedger covers, from the deployment file (never from env), and which ones a venue may list only as
// an index proxy.
import type { Deployment } from "../chain/deployment";
import type { Hex } from "./types";

export interface HedgeMarket { market: Hex; symbol: string; kind: "stock" | "crypto"; alwaysOpen: boolean }

/** Index ETFs that most perp venues list only as an index (SP500, US500): hedged with the proxy flag set. */
export const PROXY_SYMBOLS: ReadonlySet<string> = new Set(["SPY", "QQQ"]);

export function hedgeMarkets(deployment: Pick<Deployment, "markets">): HedgeMarket[] {
  return deployment.markets
    .map((m) => ({ market: m.id, symbol: m.symbol, kind: m.kind, alwaysOpen: m.alwaysOpen }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Session codes the guard reports (IODOracleGuard Session): the underlying's feed is deliberately idle while CLOSED. */
export const SESSION_CLOSED = 2;

/** How old the oracle input is for the hedge decision, in ms. A closed feed is not stale: the guard keeps its last good price and
 * says so with fresh=true, the feed simply does not update until the next open, and the hedger then sizes against the venue's own
 * mark (checked separately for age). Only an unfresh read (halted, or no good price) is infinite. */
export function oracleMarkAgeMs(read: { fresh: boolean; session: number; updatedAt: bigint | number }, nowMs: number): number {
  if (!read.fresh) return Number.POSITIVE_INFINITY;
  if (Number(read.session) === SESSION_CLOSED) return 0;
  return nowMs - Number(read.updatedAt) * 1000;
}
