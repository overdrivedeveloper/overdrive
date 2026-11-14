import { describe, expect, test } from "bun:test";
import { decideRehedge, gammaBudget, gammaPnl1pctUsd, inputsFresh, type RehedgeInput } from "./bands";
import { runHedgeCycle } from "./service";
import { makeDeps, market, USD } from "./test-support";
import { MockVenue } from "./venues/mock-venue";

const EQ = USD(1_000_000); // band 50 bps = 5,000; hard band 200 bps = 20,000
const NOW = 10_000_000;
const base: RehedgeInput = {
  residualUsd: 0n, equityUsd: EQ, inputsFresh: true, disagree: false, halted: false, nowMs: NOW, lastTradeMs: NOW - 600_000,
  bandBps: 50, hardBandBps: 200, intervalSeconds: 1800, cooldownSeconds: 120, minTradeUsd: USD(25),
};

describe("bands", () => {
  test("band_hard_interval_cooldown_table", () => {
    const rows: [string, Partial<RehedgeInput>, string, bigint | null][] = [
      ["inside band, interval not due", { residualUsd: USD(4_000) }, "within_band", null],
      ["inside band, negative", { residualUsd: -USD(4_000) }, "within_band", null],
      ["exactly at band edge holds", { residualUsd: USD(5_000) }, "within_band", null],
      ["above band trades to zero", { residualUsd: USD(5_001) }, "band", USD(5_001)],
      ["above band short side", { residualUsd: -USD(6_000) }, "band", -USD(6_000)],
      ["above hard band trades at once", { residualUsd: USD(20_001) }, "hard_band", USD(20_001)],
      ["hard band still respects cooldown", { residualUsd: USD(50_000), lastTradeMs: NOW - 60_000 }, "cooldown", null],
      ["band inside cooldown", { residualUsd: USD(6_000), lastTradeMs: NOW - 119_999 }, "cooldown", null],
      ["cooldown just over", { residualUsd: USD(6_000), lastTradeMs: NOW - 120_000 }, "band", USD(6_000)],
      ["interval due, small residual", { residualUsd: USD(30), lastTradeMs: NOW - 1_800_000 }, "interval", USD(30)],
      ["interval due, below minimum", { residualUsd: USD(24), lastTradeMs: NOW - 1_800_000 }, "below_min_size", null],
      ["first ever trade on interval", { residualUsd: USD(100), lastTradeMs: undefined }, "interval", USD(100)],
      ["zero residual", { residualUsd: 0n, lastTradeMs: undefined }, "below_min_size", null],
      ["below minimum beats band", { residualUsd: USD(20), equityUsd: USD(1_000) }, "below_min_size", null],
      ["stale inputs", { residualUsd: USD(50_000), inputsFresh: false }, "stale_inputs", null],
      ["disagreement", { residualUsd: USD(50_000), disagree: true }, "disagree_with_chain", null],
      ["no equity", { residualUsd: USD(50_000), equityUsd: 0n }, "no_equity", null],
      ["negative equity", { residualUsd: USD(50_000), equityUsd: -1n }, "no_equity", null],
      ["halted", { residualUsd: USD(50_000), halted: true }, "halted", null],
    ];
    for (const [name, over, reason, delta] of rows) {
      const d = decideRehedge({ ...base, ...over });
      expect({ name, reason: d.reason }).toEqual({ name, reason: reason as never });
      if (delta === null) expect(d.trade).toBe(false);
      else {
        expect(d.trade).toBe(true);
        // to zero, not to the band edge
        if (d.trade) expect(d.deltaUsd).toBe(delta);
      }
    }
  });

  test("gamma_over_budget_tightens_band_and_signals", async () => {
    // budget 40 bps of 1,000,000 = 4,000 per 1% move; pnl = G / 20,000, so G above 80,000,000 is over budget
    expect(gammaPnl1pctUsd(USD(275_000))).toBe(USD(275_000) / 20_000n);
    const under = gammaBudget(USD(80_000_000), EQ, 40, 50, 200);
    expect(under.over).toBe(false);
    expect(under.bandBps).toBe(50);
    const over = gammaBudget(USD(80_000_100), EQ, 40, 50, 200);
    expect(over.over).toBe(true);
    expect(over.bandBps).toBe(25);
    expect(gammaBudget(-USD(90_000_000), EQ, 40, 50, 200).over).toBe(true); // short convexity counts too

    // in the service: a residual of 3,000 (inside 50 bps, above 25 bps) trades only because gamma tightened the band
    const venue = new MockVenue({ marks: { TSLA: 400n * 10n ** 18n }, alwaysOpen: true });
    const { deps, gov, mem } = makeDeps({ markets: [market("TSLA")], venues: [venue] });
    gov.equityUsd = EQ;
    gov.delta.set("TSLA", USD(3_000));
    gov.gamma.set("TSLA", USD(10_000_000));
    deps.state.lastTradeMs.set("TSLA", deps.now() - 600_000);
    let r = await runHedgeCycle(deps);
    expect(r.names.TSLA!.reason).toBe("within_band");
    expect(mem.signals.filter((s) => s.kind === "gamma_over_budget" && s.open)).toHaveLength(0);
    gov.gamma.set("TSLA", USD(100_000_000));
    r = await runHedgeCycle(deps);
    expect(r.names.TSLA!.action).toBe("traded");
    expect(r.names.TSLA!.reason).toBe("band");
    expect(r.names.TSLA!.bandUsd).toBe(USD(2_500));
    expect(mem.signals.filter((s) => s.kind === "gamma_over_budget" && s.open)).toHaveLength(1);
    // exposed for the API, the crank risk monitor and todo 18; convexity itself never traded (position = delta)
    expect((mem.status.get("hedger")!.meta.gamma as Record<string, { over: boolean }>).TSLA!.over).toBe(true);
    expect(await venue.netPositionUsd("TSLA")).toBe(USD(3_000));
  });

  test("stale_inputs_hold_never_trade", async () => {
    expect(inputsFresh({ exposureAgeMs: 900_000, markAgeMs: 0 }, 900)).toBe(true);
    expect(inputsFresh({ exposureAgeMs: 900_001, markAgeMs: 0 }, 900)).toBe(false);
    expect(inputsFresh({ exposureAgeMs: 0, markAgeMs: Number.POSITIVE_INFINITY }, 900)).toBe(false);

    const venue = new MockVenue({ marks: { TSLA: 400n * 10n ** 18n, NVDA: 200n * 10n ** 18n, AMD: 150n * 10n ** 18n, AAPL: 230n * 10n ** 18n }, alwaysOpen: true });
    const { deps, gov, markAge, clock } = makeDeps({ markets: [market("TSLA"), market("NVDA"), market("AMD"), market("AAPL")], venues: [venue] });
    for (const s of ["TSLA", "NVDA", "AMD", "AAPL"]) gov.delta.set(s, USD(500_000));
    gov.timestampMs = clock.now - 901_000;            // Governor exposure too old: every name holds
    let r = await runHedgeCycle(deps);
    for (const s of ["TSLA", "NVDA", "AMD", "AAPL"]) {
      expect(r.names[s]!.reason).toBe("stale_inputs");
      expect(r.names[s]!.hedged).toBe(false);
    }
    expect(venue.fills).toHaveLength(0);
    gov.timestampMs = clock.now;
    markAge.set("TSLA", 901_000);                      // the oracle mark too old
    venue.markAgeMs = 0;
    gov.equityUsd = USD(10_000_000);
    r = await runHedgeCycle(deps);
    expect(r.names.TSLA!.reason).toBe("stale_inputs");
    expect(r.names.TSLA!.hedged).toBe(false);
    expect(r.unhedged.TSLA).toBeDefined();
    expect(r.names.NVDA!.action).toBe("traded");
    // a venue mark older than 60 s: that venue is skipped, nothing trades, never marked hedged
    clock.now += 200_000;                              // past the cooldown of the previous trade
    gov.timestampMs = clock.now;
    venue.markAgeMs = 61_000;
    gov.delta.set("AMD", USD(900_000));
    r = await runHedgeCycle(deps);
    expect(r.names.AMD!.action).not.toBe("traded");
    expect(r.names.AMD!.reason).toBe("no_venue");
    expect(r.names.AMD!.hedged).toBe(false);
    // zero equity: nothing trades
    venue.markAgeMs = 0;
    gov.equityUsd = 0n;
    gov.delta.set("AAPL", USD(700_000));
    const before = venue.fills.length;
    r = await runHedgeCycle(deps);
    expect(r.names.AAPL!.reason).toBe("no_equity");
    expect(r.names.AAPL!.hedged).toBe(false);
    expect(venue.fills.length).toBe(before);
  });
});
