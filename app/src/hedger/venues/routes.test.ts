import { describe, expect, test } from "bun:test";
import { runHedgeCycle } from "../service";
import { makeDeps, market, USD } from "../test-support";
import { MockVenue } from "./mock-venue";
import { routeFor, routeOrder } from "./routes";

const PX = (n: number) => BigInt(n) * 10n ** 18n;

describe("routes", () => {
  test("ordered_skip_split_and_margin_cap", async () => {
    expect(routeOrder({ symbol: "ETH", kind: "crypto" })).toEqual(["hyperliquid", "arcus", "mock"]);
    expect(routeOrder({ symbol: "TSLA", kind: "stock" })).toEqual(["arcus", "hyperliquid", "mock"]);

    const arcus = new MockVenue({ name: "arcus", marks: { TSLA: PX(400), ETH: PX(3_000) }, alwaysOpen: true, depthUsd: USD(200_000) });
    const hl = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400), ETH: PX(3_000) }, alwaysOpen: true, depthUsd: USD(1_000_000) });
    expect(routeFor(market("TSLA"), [hl, arcus]).map((v) => v.name)).toEqual(["arcus", "hyperliquid"]);
    expect(routeFor(market("ETH", true), [arcus, hl]).map((v) => v.name)).toEqual(["hyperliquid", "arcus"]);

    // split: Arcus takes only 25% of its 200,000 visible depth = 50,000; the rest goes to Hyperliquid
    const { deps, gov } = makeDeps({ markets: [market("TSLA"), market("ETH", true)], venues: [hl, arcus] });
    deps.routeFor = routeFor;
    gov.delta.set("TSLA", USD(120_000));
    gov.delta.set("ETH", USD(60_000));
    const r = await runHedgeCycle(deps);
    expect(await arcus.netPositionUsd("TSLA")).toBe(USD(50_000));
    expect(await hl.netPositionUsd("TSLA")).toBe(USD(70_000));
    expect(r.names.TSLA!.fills.map((f) => f.venue)).toEqual(["arcus", "hyperliquid"]);
    expect(await hl.netPositionUsd("ETH")).toBe(USD(60_000)); // crypto goes to Hyperliquid first
    expect(await arcus.netPositionUsd("ETH")).toBe(0n);

    // skip: Arcus unhealthy, everything to Hyperliquid
    const a2 = new MockVenue({ name: "arcus", marks: { TSLA: PX(400) }, alwaysOpen: true });
    const h2 = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400) }, alwaysOpen: true });
    a2.setHealthy(false);
    const d2 = makeDeps({ markets: [market("TSLA")], venues: [a2, h2] });
    d2.deps.routeFor = routeFor;
    d2.gov.delta.set("TSLA", USD(80_000));
    await runHedgeCycle(d2.deps);
    expect(a2.calls.trade).toBe(0);
    expect(await h2.netPositionUsd("TSLA")).toBe(USD(80_000));

    // margin cap: 20,000 of margin at 5x caps a venue at 100,000 of position; the remainder spills to the next venue
    const a3 = new MockVenue({ name: "arcus", marks: { TSLA: PX(400) }, alwaysOpen: true });
    const h3 = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400) }, alwaysOpen: true });
    const d3 = makeDeps({ markets: [market("TSLA")], venues: [a3, h3], settings: { maxVenueMarginUsd: USD(20_000) } });
    d3.deps.routeFor = routeFor;
    d3.gov.delta.set("TSLA", USD(150_000));
    const r3 = await runHedgeCycle(d3.deps);
    expect(await a3.netPositionUsd("TSLA")).toBe(USD(100_000));
    expect(await h3.netPositionUsd("TSLA")).toBe(USD(50_000));
    expect(r3.names.TSLA!.hedged).toBe(true);
  });

  test("spy_qqq_go_to_arcus_when_configured_and_hl_proxy_is_overflow", async () => {
    // Hyperliquid mainnet hedges SPY and QQQ only through index proxies (hlRoute: xyz:SP500, xyz:XYZ100)
    const hl = new MockVenue({ name: "hyperliquid", marks: { SPY: PX(800), QQQ: PX(640), TSLA: PX(400) }, alwaysOpen: true, proxies: ["SPY", "QQQ"] });
    const arcus = new MockVenue({ name: "arcus", marks: { SPY: PX(800), QQQ: PX(640) }, alwaysOpen: true });
    for (const sym of ["SPY", "QQQ"]) expect(routeFor(market(sym), [hl, arcus]).map((v) => v.name)).toEqual(["arcus", "hyperliquid"]);
    // a proxy venue goes after a native one even when the kind order puts it first
    expect(routeFor({ symbol: "SPY", kind: "crypto" }, [hl, arcus]).map((v) => v.name)).toEqual(["arcus", "hyperliquid"]);
    // Arcus not configured: the Hyperliquid route is unchanged
    expect(routeFor(market("SPY"), [hl]).map((v) => v.name)).toEqual(["hyperliquid"]);
    expect(routeFor(market("ETH", true), [arcus, hl]).map((v) => v.name)).toEqual(["hyperliquid", "arcus"]);

    const { deps, gov } = makeDeps({ markets: [market("SPY"), market("QQQ")], venues: [hl, arcus] });
    deps.routeFor = routeFor;
    gov.delta.set("SPY", USD(100_000));
    gov.delta.set("QQQ", USD(-80_000));
    const r = await runHedgeCycle(deps);
    expect(r.names.SPY!.fills.map((f) => f.venue)).toEqual(["arcus"]);
    expect(await arcus.netPositionUsd("SPY")).toBe(USD(100_000));
    expect(await arcus.netPositionUsd("QQQ")).toBe(USD(-80_000));
    expect(hl.calls.trade).toBe(0);
  });

  test("a_market_hl_lacks_goes_to_arcus_and_one_nobody_lists_fails_closed", async () => {
    const hl = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400) }, alwaysOpen: true });
    const arcus = new MockVenue({ name: "arcus", marks: { HOOD: PX(80) }, alwaysOpen: true });
    const { deps, gov } = makeDeps({ markets: [market("HOOD"), market("ZZZZ")], venues: [hl, arcus] });
    deps.routeFor = routeFor;
    gov.delta.set("HOOD", USD(50_000));
    gov.delta.set("ZZZZ", USD(50_000));
    const r = await runHedgeCycle(deps);
    expect(await arcus.netPositionUsd("HOOD")).toBe(USD(50_000));
    expect(r.names.ZZZZ!.reason).toBe("no_venue");
    expect(r.names.ZZZZ!.hedged).toBe(false);
    expect(hl.calls.trade + arcus.calls.trade).toBe(1);
  });
});
