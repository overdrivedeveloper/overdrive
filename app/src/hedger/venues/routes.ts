// R6: per underlying the venue order. ETH and BTC: Hyperliquid main book, then Arcus. Stocks: Arcus, then Hyperliquid HIP-3
// (24/7). A venue that would hedge the name only through a proxy (Hyperliquid mainnet has no SPY or QQQ, only the SP500 and
// XYZ100 indexes) goes after every venue that lists the name itself, so with Arcus configured SPY and QQQ go to Arcus and
// the Hyperliquid proxy is only overflow; without Arcus the Hyperliquid route is unchanged. A venue that does not list a
// name at all is dropped by the service (canTrade), and a name no venue lists holds with reason no_venue (fail closed).
// The service then skips unhealthy venues, closed markets and stale marks, splits by visible depth share, and keeps each
// venue's margin under HEDGER_MAX_VENUE_MARGIN_USDG (service.ts).
import type { HedgeMarket } from "../markets";
import type { IHedgeVenue, VenueName } from "../types";

export function routeOrder(m: Pick<HedgeMarket, "symbol" | "kind">): VenueName[] {
  if (m.kind === "crypto" || m.symbol === "ETH" || m.symbol === "BTC") return ["hyperliquid", "arcus", "mock"];
  return ["arcus", "hyperliquid", "mock"];
}

export function routeFor(m: Pick<HedgeMarket, "symbol" | "kind">, venues: readonly IHedgeVenue[]): IHedgeVenue[] {
  const order = routeOrder(m);
  const proxy = (v: IHedgeVenue) => (v.basis(m.symbol).proxy ? 1 : 0);
  return [...venues]
    .filter((v) => order.includes(v.name))
    .sort((a, b) => proxy(a) - proxy(b) || order.indexOf(a.name) - order.indexOf(b.name));
}
