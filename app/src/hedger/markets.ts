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
