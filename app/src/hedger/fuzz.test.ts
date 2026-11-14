import { describe, expect, test } from "bun:test";
import { exposureFromGears } from "./netting";
import { runHedgeCycle } from "./service";
import { makeDeps, market, USD } from "./test-support";
import type { GearBook } from "./types";
import { MockVenue } from "./venues/mock-venue";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMBOLS = ["NVDA", "TSLA"];
const GEARS: [string, number][] = [["SPORT", 2], ["RACE", 3], ["CRUISE", 1.5], ["ECO", 0.5], ["REVERSE", -1]];
const abs = (x: bigint) => (x < 0n ? -x : x);
// A hold or a partial fill is allowed to leave a residual above the band only with one of these recorded reasons.
const HOLD_REASONS = new Set(["cooldown", "stale_inputs", "disagree_with_chain", "no_venue", "trade_failed", "partial", "halted", "below_min_size"]);

interface Sim { rnd: () => number; books: GearBook[]; px: Map<string, number> }

function newSim(seed: number): Sim {
  const rnd = mulberry32(seed);
  const books: GearBook[] = [];
  for (const s of SYMBOLS) for (const [g, p] of GEARS) books.push({ gear: `${s}-${g}`, power: p, marketA: s, marketB: null, valueUsd: rnd() * 400_000 });
  books.push({ gear: "NVDA/TSLA-SPORT", power: 2, marketA: "NVDA", marketB: "TSLA", valueUsd: rnd() * 200_000 });
  return { rnd, books, px: new Map([["NVDA", 200], ["TSLA", 400]]) };
}

/** One step: prices walk (stdev ~1.5%), gear values follow their index, and a random gear sees a buy or a sell. */
function step(sim: Sim, movePrices: boolean) {
  const ratios = new Map<string, number>();
  for (const s of SYMBOLS) {
    const r = movePrices ? Math.exp((sim.rnd() - 0.5) * 0.05) : 1;
    ratios.set(s, r);
    sim.px.set(s, sim.px.get(s)! * r);
  }
  for (const b of sim.books) {
    b.valueUsd *= Math.pow(ratios.get(b.marketA)!, b.power) * (b.marketB ? Math.pow(ratios.get(b.marketB)!, -b.power) : 1);
  }
  const g = sim.books[Math.floor(sim.rnd() * sim.books.length)]!;
  g.valueUsd = Math.max(0, g.valueUsd + (sim.rnd() - 0.45) * 150_000);
}

const toUsd = (n: number) => BigInt(Math.round(n * 1e6));
const pxWad = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("hedger fuzz", () => {
  test("residual_always_in_band_or_held_with_reason", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const sim = newSim(seed);
      const venue = new MockVenue({
        marks: { NVDA: pxWad(200), TSLA: pxWad(400) }, alwaysOpen: true, slippageBps: seed % 4 === 0 ? 30 : 0,
        fillRatioBps: seed % 5 === 0 ? 7_000 : 10_000, ...(seed % 3 === 0 ? { depthUsd: USD(400_000) } : {}),
      });
      const { deps, gov, advance } = makeDeps({ markets: SYMBOLS.map((s) => market(s)), venues: [venue] });
      gov.equityUsd = USD(8_000_000);
      for (let i = 0; i < 500; i++) {
        step(sim, true);
        for (const s of SYMBOLS) venue.setMark(s, pxWad(sim.px.get(s)!));
        const exp = exposureFromGears(sim.books, new Map());
        for (const s of SYMBOLS) gov.delta.set(s, toUsd(exp.get(s)?.deltaUsd ?? 0));
        if (sim.rnd() < 0.02) venue.failNext();
        advance(60_000);
        const r = await runHedgeCycle(deps);
        for (const s of SYMBOLS) {
          const n = r.names[s]!;
          const residual = gov.delta.get(s)! - (await venue.netPositionUsd(s));
          const inBand = abs(residual) <= n.bandUsd;
          if (!inBand && !HOLD_REASONS.has(n.reason)) throw new Error(`seed ${seed} step ${i} ${s}: residual ${residual} band ${n.bandUsd} reason ${n.reason}`);
          // a held name is never marked hedged when outside the band
          if (!inBand && n.action === "hold" && n.reason !== "below_min_size") expect(n.hedged).toBe(n.reason === "cooldown");
        }
      }
      expect(venue.fills.length).toBeGreaterThan(50); // the walk really trades
    }
  }, 120_000);

  test("trades_never_increase_residual", async () => {
    for (let seed = 101; seed <= 110; seed++) {
      const sim = newSim(seed);
      const venue = new MockVenue({ marks: { NVDA: pxWad(200), TSLA: pxWad(400) }, alwaysOpen: true, fillRatioBps: seed % 2 ? 10_000 : 6_000, depthUsd: USD(300_000) });
      const { deps, gov, mem, advance } = makeDeps({ markets: SYMBOLS.map((s) => market(s)), venues: [venue], settings: { cooldownSeconds: 0 } });
      gov.equityUsd = USD(5_000_000);
      const start = new Map<string, bigint>();
      for (const s of SYMBOLS) { venue.units.set(s, BigInt(Math.round(sim.rnd() * 1000)) * 10n ** 18n); start.set(s, await venue.netPositionUsd(s)); }
      for (let i = 0; i < 300; i++) {
        step(sim, false); // constant marks so recorded USD fills sum exactly
        const exp = exposureFromGears(sim.books, new Map());
        for (const s of SYMBOLS) gov.delta.set(s, toUsd(exp.get(s)?.deltaUsd ?? 0));
        if (sim.rnd() < 0.05) venue.failNext();
        advance(60_000);
        const before = new Map<string, bigint>();
        for (const s of SYMBOLS) before.set(s, gov.delta.get(s)! - (await venue.netPositionUsd(s)));
        await runHedgeCycle(deps);
        for (const s of SYMBOLS) {
          const after = gov.delta.get(s)! - (await venue.netPositionUsd(s));
          expect(abs(after) <= abs(before.get(s)!)).toBe(true);
          // never overshoots: a trade never flips the residual past zero by more than rounding
          if (before.get(s)! > 0n) expect(after >= -1n).toBe(true);
          if (before.get(s)! < 0n) expect(after <= 1n).toBe(true);
        }
      }
      expect(mem.hedges.length).toBeGreaterThan(30);
      for (const s of SYMBOLS) {
        const fills = mem.hedges.filter((h) => h.underlying === s && !h.dry).reduce((a, h) => a + h.usd, 0n);
        expect(abs(start.get(s)! + fills - (await venue.netPositionUsd(s)))).toBeLessThanOrEqual(deps.settings.minTradeUsd);
      }
    }
  }, 120_000);
});
