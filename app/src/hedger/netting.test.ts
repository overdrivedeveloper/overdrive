import { describe, expect, test } from "bun:test";
import { computeLedger } from "../indexer/snapshot";
import { fixed, WAD } from "../lib/fixed";
import { exposureFromGears, gammaPnl1pct, gearValueAfterMove, hedgeTargetUsd, netAcrossGears } from "./netting";
import type { GearBook } from "./types";

const POWERS = [1.5, 2, 3, 0.5, -1];
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe("netting", () => {
  test("sport_eco_reverse_vector", () => {
    const gears: GearBook[] = [
      { gear: "SPORT", power: 2, marketA: "TSLA", marketB: null, valueUsd: 100_000 },
      { gear: "ECO", power: 0.5, marketA: "TSLA", marketB: null, valueUsd: 100_000 },
      { gear: "REVERSE", power: -1, marketA: "TSLA", marketB: null, valueUsd: 50_000 },
    ];
    const net = netAcrossGears(gears);
    expect(net.deltaUsd).toBe(200_000);
    expect(net.gammaUsd).toBe(275_000);
    expect(net.byGear.SPORT).toEqual({ delta: 200_000, gamma: 200_000 });
    expect(net.byGear.ECO).toEqual({ delta: 50_000, gamma: -25_000 });
    expect(net.byGear.REVERSE).toEqual({ delta: -50_000, gamma: 100_000 });
    const e = exposureFromGears(gears, new Map()).get("TSLA")!;
    expect(e.deltaUsd).toBe(200_000);
    expect(e.gammaUsd).toBe(275_000);
    // the hedge target is the delta only
    expect(hedgeTargetUsd(e)).toBe(200_000);
    expect(gammaPnl1pct(e.gammaUsd)).toBeCloseTo(13.75, 9);
  });

  // The TypeScript index twin from todo 03 (app/src/pricing/index.ts) is not on this branch yet; the gear index is
  // V0 (S/S0)^p, which is what gearValueAfterMove computes, and the bigint ledger the indexer writes (the contract's rule)
  // is checked below for the same fixture.
  test("matches_finite_difference_all_powers", () => {
    const v0 = 123_456.789;
    for (const p of POWERS) {
      const h = 1e-4;
      const at = (s: number) => gearValueAfterMove(v0, p, s);
      // dV/dlnS by central difference in ln S; S^2 d2V/dS2 by central difference in S (S0 = 1)
      const dlnS = (at(Math.exp(h)) - at(Math.exp(-h))) / (2 * h);
      const d2 = (at(1 + h) - 2 * at(1) + at(1 - h)) / (h * h);
      const e = exposureFromGears([{ gear: `g${p}`, power: p, marketA: "X", marketB: null, valueUsd: v0 }], new Map()).get("X")!;
      expect(rel(e.deltaUsd, dlnS)).toBeLessThan(1e-6);
      expect(rel(e.gammaUsd, d2)).toBeLessThan(1e-6);
      // and after a 7% move the formulas still hold at the new value
      const moved = exposureFromGears([{ gear: "g", power: p, marketA: "X", marketB: null, valueUsd: v0 }], new Map([["X", 1.07]])).get("X")!;
      expect(rel(moved.deltaUsd, p * at(1.07))).toBeLessThan(1e-12);
      // bigint ledger twin (indexer snapshot, the contract's p_eff rule) agrees to the micro-dollar
      const powerWad = fixed(String(p));
      const ledger = computeLedger([{ marketA: "X", marketB: null, powerWad, holderTokens: 1000n * WAD, valuePerTokenWad: fixed("123.456789") }], (s) => s)[0]!;
      expect(rel(Number(ledger.deltaUsdg) / 1e6, p * 123_456.789)).toBeLessThan(1e-6);
      expect(rel(Number(ledger.gammaUsdg) / 1e6, p * (p - 1) * 123_456.789)).toBeLessThan(1e-6);
    }
  });

  test("pair_legs_and_cross_term", () => {
    const v0 = 10_000;
    for (const p of POWERS) {
      const out = exposureFromGears([{ gear: "PAIR", power: p, marketA: "A", marketB: "B", valueUsd: v0 }], new Map());
      const a = out.get("A")!;
      const b = out.get("B")!;
      expect(a.deltaUsd).toBeCloseTo(p * v0, 9);
      expect(b.deltaUsd).toBeCloseTo(-p * v0, 9);
      expect(a.gammaUsd).toBeCloseTo(p * (p - 1) * v0, 9);
      expect(b.gammaUsd).toBeCloseTo(p * (p + 1) * v0, 9);
      expect(a.cross.B).toBeCloseTo(-p * p * v0, 9);
      expect(b.cross.A).toBeCloseTo(-p * p * v0, 9);
      // finite differences of V(A, B) = V0 (A/B)^p
      const h = 1e-4;
      const V = (x: number, y: number) => gearValueAfterMove(v0, p, x, y);
      const dB = (V(1, Math.exp(h)) - V(1, Math.exp(-h))) / (2 * h);
      const dBB = (V(1, 1 + h) - 2 * V(1, 1) + V(1, 1 - h)) / (h * h);
      const dAB = (V(1 + h, 1 + h) - V(1 + h, 1 - h) - V(1 - h, 1 + h) + V(1 - h, 1 - h)) / (4 * h * h);
      expect(rel(b.deltaUsd, dB)).toBeLessThan(1e-6);
      expect(rel(b.gammaUsd, dBB)).toBeLessThan(1e-6);
      expect(rel(a.cross.B!, dAB)).toBeLessThan(1e-6);
      // cross terms are never netted into either name's gamma
      expect(a.gammaUsd + b.gammaUsd).toBeCloseTo(p * (p - 1) * v0 + p * (p + 1) * v0, 9);
      // the bigint ledger matches the legs
      const powerWad = fixed(String(p));
      const ledger = computeLedger([{ marketA: "A", marketB: "B", powerWad, holderTokens: 100n * WAD, valuePerTokenWad: 100n * WAD }], (s) => s);
      const lb = ledger.find((r) => r.underlying === "B")!;
      expect(Number(lb.deltaUsdg) / 1e6).toBeCloseTo(-p * v0, 3);
      expect(Number(lb.gammaUsdg) / 1e6).toBeCloseTo(p * (p + 1) * v0, 3);
    }
    expect(() => netAcrossGears([{ gear: "P", power: 2, marketA: "A", marketB: "B", valueUsd: 1 }])).toThrow("pair");
  });
});
