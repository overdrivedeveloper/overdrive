// R6: per underlying the venue order. ETH and BTC: Hyperliquid main book, then Arcus. Stocks: Arcus, then Hyperliquid HIP-3
// (24/7). The service then skips unhealthy venues, closed markets and stale marks, splits by visible depth share, and keeps
// each venue's margin under HEDGER_MAX_VENUE_MARGIN_USDG (service.ts).
import type { HedgeMarket } from "../markets";
import type { IHedgeVenue, VenueName } from "../types";

export function routeOrder(m: Pick<HedgeMarket, "symbol" | "kind">): VenueName[] {
  if (m.kind === "crypto" || m.symbol === "ETH" || m.symbol === "BTC") return ["hyperliquid", "arcus", "mock"];
  return ["arcus", "hyperliquid", "mock"];
}

export function routeFor(m: Pick<HedgeMarket, "symbol" | "kind">, venues: readonly IHedgeVenue[]): IHedgeVenue[] {
  const order = routeOrder(m);
  return [...venues].filter((v) => order.includes(v.name)).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}
