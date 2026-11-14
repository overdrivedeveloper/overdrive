import { describe, expect, test } from "bun:test";
import { runHedgeCycle } from "./service";
import { makeDeps, market, USD } from "./test-support";
import type { IHedgeVenue } from "./types";
import { MockVenue } from "./venues/mock-venue";

const PX = (n: number) => BigInt(n) * 10n ** 18n;

describe("hedge service", () => {
  test("chain_is_target_source", async () => {
    const venue = new MockVenue({ marks: { TSLA: PX(400) }, alwaysOpen: true });
    const { deps, gov, indexed } = makeDeps({ markets: [market("TSLA")], venues: [venue] });
    gov.delta.set("TSLA", USD(200_000));
    // the indexed book is off by 20 USDG: inside the 25 USDG floor, so the chain value is the target, not the indexed one
    indexed.override.set("TSLA", { block: gov.block, ts: new Date(deps.now()), deltaUsd: USD(199_980), gammaUsd: 0n, equityUsd: gov.equityUsd });
    const r = await runHedgeCycle(deps);
    expect(gov.reads).toEqual([{ symbol: "TSLA", block: 100n }]);
    expect(r.names.TSLA!.deltaUsd).toBe(USD(200_000));
    expect(r.names.TSLA!.action).toBe("traded");
    expect(await venue.netPositionUsd("TSLA")).toBe(USD(200_000));
    // an unreadable getter holds (fail closed)
    gov.unreadable.add("TSLA");
    gov.delta.set("TSLA", USD(900_000));
    const held = await runHedgeCycle(deps);
    expect(held.names.TSLA!.action).toBe("hold");
    expect(held.names.TSLA!.hedged).toBe(false);
    expect(venue.fills).toHaveLength(1);
  });

  test("disagreement_holds_and_signals", async () => {
    const venue = new MockVenue({ marks: { TSLA: PX(400) }, alwaysOpen: true });
    const { deps, gov, indexed, mem } = makeDeps({ markets: [market("TSLA")], venues: [venue] });
    gov.equityUsd = USD(10_000_000); // tolerance = max(0.5% x 10,000,000 = 50,000, 25)
    gov.delta.set("TSLA", USD(500_000));
    indexed.override.set("TSLA", { block: gov.block, ts: new Date(deps.now()), deltaUsd: USD(449_999), gammaUsd: 0n, equityUsd: gov.equityUsd });
    const r = await runHedgeCycle(deps);
    expect(r.names.TSLA!.reason).toBe("disagree_with_chain");
    expect(r.names.TSLA!.action).toBe("hold");
    expect(venue.calls.trade).toBe(0);
    const sig = mem.signals.find((s) => s.kind === "disagree_with_chain");
    expect(sig?.open).toBe(true);
    expect(sig?.detail.chainDeltaUsd).toBe(USD(500_000).toString());
    // within tolerance: trades and clears the signal
    indexed.override.set("TSLA", { block: gov.block, ts: new Date(deps.now()), deltaUsd: USD(450_000), gammaUsd: 0n, equityUsd: gov.equityUsd });
    const ok = await runHedgeCycle(deps);
    expect(ok.names.TSLA!.action).toBe("traded");
    expect(mem.signals.find((s) => s.kind === "disagree_with_chain")?.open).toBe(false);
    // no indexed row at all: nothing to check against, hold
    indexed.override.set("TSLA", null);
    gov.delta.set("TSLA", USD(800_000));
    const none = await runHedgeCycle(deps);
    expect(none.names.TSLA!.action).toBe("hold");
  });

  test("one_name_failing_does_not_stop_the_pass", async () => {
    const good = new MockVenue({ marks: { AAPL: PX(230), TSLA: PX(400) }, alwaysOpen: true });
    const broken: IHedgeVenue = Object.assign(Object.create(good), { name: "arcus", netPositionUsd: async (u: string) => { if (u === "AAPL") throw new Error("boom"); return 0n; } });
    // AAPL is sorted first and its position read throws; TSLA must still hedge, AAPL is reported unhedged with a since time
    const { deps, gov, mem } = makeDeps({ markets: [market("AAPL"), market("NOVENUE"), market("TSLA")], venues: [good, broken] });
    gov.delta.set("AAPL", USD(300_000));
    gov.delta.set("NOVENUE", USD(300_000));
    gov.delta.set("TSLA", USD(300_000));
    const r = await runHedgeCycle(deps);
    expect(Object.keys(r.names)).toEqual(["AAPL", "NOVENUE", "TSLA"]);
    expect(r.names.AAPL!.action).toBe("failed");
    expect(r.names.NOVENUE!.reason).toBe("no_venue");
    expect(r.names.TSLA!.action).toBe("traded");
    expect(r.unhedged.AAPL?.since).toBe(new Date(deps.now()).toISOString());
    expect(r.unhedged.NOVENUE?.usd).toBe(USD(300_000).toString());
    expect((mem.status.get("hedger")!.meta.unhedged as Record<string, unknown>).NOVENUE).toBeDefined();
    expect(mem.cycles.map((c) => c.underlying)).toEqual(["AAPL", "NOVENUE", "TSLA"]);
  });

  test("weekend_hedges_on_24_7_venue_only", async () => {
    const session = new MockVenue({ name: "arcus", marks: { TSLA: PX(400) }, alwaysOpen: false });
    const allHours = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400) }, alwaysOpen: true });
    session.sessionOpen = false; // the equity feed session is closed; holders can still sell
    const { deps, gov } = makeDeps({ markets: [market("TSLA")], venues: [session, allHours] });
    gov.delta.set("TSLA", USD(100_000));
    const r = await runHedgeCycle(deps);
    expect(r.names.TSLA!.action).toBe("traded");
    expect(session.calls.trade).toBe(0);
    expect(await allHours.netPositionUsd("TSLA")).toBe(USD(100_000)); // never larger than the residual
    // no 24/7 venue: hold, reported
    allHours.setHealthy(false);
    gov.delta.set("TSLA", USD(300_000));
    deps.state.lastTradeMs.clear();
    const held = await runHedgeCycle(deps);
    expect(held.names.TSLA!.reason).toBe("no_venue");
    expect(session.calls.trade).toBe(0);
  });

  test("retry_after_timeout_does_not_double_trade", async () => {
    const venue = new MockVenue({ marks: { TSLA: PX(400) }, alwaysOpen: true });
    const { deps, gov, mem } = makeDeps({ markets: [market("TSLA")], venues: [venue] });
    gov.delta.set("TSLA", USD(100_000));
    venue.fillThenTimeoutNext();
    const r = await runHedgeCycle(deps);
    expect(venue.calls.trade).toBe(1);           // the retry asked first and found the fill
    expect(venue.fills).toHaveLength(1);
    expect(r.names.TSLA!.action).toBe("traded");
    expect(mem.hedges).toHaveLength(1);
    expect(await venue.netPositionUsd("TSLA")).toBe(USD(100_000));
    // a crash between send and record: same bucket, same target, same client id; the next pass asks before sending
    const lost = mem.hedges.pop()!;
    venue.units.set("TSLA", 0n);                 // pretend the venue fill is not visible in the position yet
    deps.state.lastTradeMs.clear();
    await runHedgeCycle(deps);
    expect(venue.calls.trade).toBe(1);
    expect(mem.hedges[0]!.clientId).toBe(lost.clientId);
    // a plain timeout with no fill retries once with the same id
    const v2 = new MockVenue({ marks: { NVDA: PX(200) }, alwaysOpen: true });
    const d2 = makeDeps({ markets: [market("NVDA")], venues: [v2] });
    d2.gov.delta.set("NVDA", USD(50_000));
    v2.failNext(new Error("request timed out"));
    await runHedgeCycle(d2.deps);
    expect(v2.calls.trade).toBe(2);
    expect(v2.fills).toHaveLength(1);
  });

  test("dry_run_sends_nothing", async () => {
    const venue = new MockVenue({ marks: { TSLA: PX(400) }, alwaysOpen: true, fundable: true });
    let asked = 0;
    const { deps, gov, mem } = makeDeps({ markets: [market("TSLA")], venues: [venue], settings: { dryRun: true, maxVenueMarginUsd: USD(1_000_000) } });
    deps.requestMargin = async () => { asked++; };
    gov.delta.set("TSLA", USD(200_000));
    const r = await runHedgeCycle(deps);
    expect(r.dryRun).toBe(true);
    expect(r.names.TSLA!.action).toBe("would_trade");
    expect(venue.calls.trade).toBe(0);
    expect(asked).toBe(0);
    expect(mem.hedges).toHaveLength(1);
    expect(mem.hedges[0]!.dry).toBe(true);
    expect(mem.hedges[0]!.usd).toBe(USD(200_000));
    expect(mem.cycles).toHaveLength(1);
    expect(mem.cycles[0]!.action).toBe("would_trade");
  });

  test("send_to_hedger_bounded_and_only_when_margin_needed", async () => {
    // 5x leverage (2000 bps): 100,000 of position needs 20,000 of margin
    const venue = new MockVenue({ name: "arcus", marks: { TSLA: PX(400) }, alwaysOpen: true, fundable: true, collateralUsd: USD(30_000) });
    const asks: bigint[] = [];
    const { deps, gov } = makeDeps({ markets: [market("TSLA")], venues: [venue], settings: { maxVenueMarginUsd: USD(50_000) } });
    deps.requestMargin = async (v, usd) => { asks.push(usd); (v as MockVenue).deposit(usd); };
    gov.delta.set("TSLA", USD(100_000));
    await runHedgeCycle(deps);
    expect(asks).toEqual([]);                    // enough margin: nothing requested
    deps.state.lastTradeMs.clear();
    gov.delta.set("TSLA", USD(400_000));        // needs 80,000; cap 50,000 => asks only up to the cap
    const r = await runHedgeCycle(deps);
    expect(asks).toHaveLength(1);
    expect(asks[0]! + USD(30_000) - USD(100_000)).toBeLessThanOrEqual(USD(50_000)); // margin equity never above the cap
    expect(await venue.netPositionUsd("TSLA")).toBe(USD(250_000));                 // 50,000 x 5
    expect(r.names.TSLA!.reason).toBe("partial");
    expect(r.unhedged.TSLA?.usd).toBe(USD(150_000).toString());
    // a venue that is not fundable (Hyperliquid) is never topped up
    const hl = new MockVenue({ name: "hyperliquid", marks: { TSLA: PX(400) }, alwaysOpen: true, collateralUsd: USD(1_000) });
    const d2 = makeDeps({ markets: [market("TSLA")], venues: [hl], settings: { maxVenueMarginUsd: USD(50_000) } });
    let hlAsks = 0;
    d2.deps.requestMargin = async () => { hlAsks++; };
    d2.gov.delta.set("TSLA", USD(100_000));
    await runHedgeCycle(d2.deps);
    expect(hlAsks).toBe(0);
    expect(await hl.netPositionUsd("TSLA")).toBe(USD(5_000));
  });
});
