import { describe, expect, test } from "bun:test";
import {
  Gear,
  MAX_R,
  MIN_R,
  RatioZeroError,
  Rounding,
  WAD,
  index,
  pairPrice,
  ratio,
  shockFactor,
  sqrt,
  value,
} from "../../src/pricing/index";
import { MAX_ABS_PER_SEC, MAX_NF, MIN_NF, normStep, tollValue } from "../../src/pricing/norm";
import { gapRate, perDay, perSecond, tollPerYear, usage } from "../../src/pricing/toll";

const gears = [Gear.CRUISE, Gear.SPORT, Gear.RACE, Gear.ECO, Gear.REVERSE];
const pct = (x: bigint) => Number(x) / 1e16; // WAD fraction to percent

describe("index (twin of ODIndex)", () => {
  test("closed forms at known points", () => {
    expect(index(Gear.SPORT, 2n * WAD, Rounding.Floor)).toBe(4n * WAD);
    expect(index(Gear.RACE, 10n * WAD, Rounding.Floor)).toBe(1000n * WAD);
    expect(index(Gear.CRUISE, 2n * WAD, Rounding.Floor)).toBe(2828427124746190097n);
    expect(index(Gear.ECO, 2n * WAD, Rounding.Floor)).toBe(1414213562373095048n);
    expect(index(Gear.REVERSE, 9n * 10n ** 17n, Rounding.Ceil)).toBe(1111111111111111112n);
    for (const g of gears) expect(index(g, WAD, Rounding.Floor)).toBe(WAD);
  });

  test("overview table within 0.05 points", () => {
    const up = [15.4, 21, 33.1, 4.88, -9.09];
    const down = [-14.6, -19, -27.1, -5.13, 11.1];
    for (const g of gears) {
      const vu = value(g, 110n * WAD, 100n * WAD, WAD, WAD, Rounding.Floor).valueWad;
      const vd = value(g, 90n * WAD, 100n * WAD, WAD, WAD, Rounding.Floor).valueWad;
      expect(Math.abs(pct(vu - WAD) - (up[g] ?? 0))).toBeLessThan(0.05);
      expect(Math.abs(pct(vd - WAD) - (down[g] ?? 0))).toBeLessThan(0.05);
    }
  });

  test("ratio clamps, flags and rejects zero", () => {
    expect(ratio(1n, 100n * WAD, Rounding.Floor)).toEqual({ r: MIN_R, inDomain: false });
    expect(ratio(5001n * WAD, 100n * WAD, Rounding.Floor)).toEqual({ r: MAX_R, inDomain: false });
    expect(ratio(5000n * WAD, 100n * WAD, Rounding.Floor)).toEqual({ r: MAX_R, inDomain: true });
    expect(() => ratio(0n, WAD, Rounding.Floor)).toThrow(RatioZeroError);
  });

  test("rounding bracket and monotonicity on a grid", () => {
    let prev = gears.map(() => 0n);
    for (let r = MIN_R; r <= MAX_R; r += 123456789012345678n) {
      gears.forEach((g, k) => {
        const lo = index(g, r, Rounding.Floor);
        const hi = index(g, r, Rounding.Ceil);
        expect(lo <= hi && hi <= lo + 3n).toBe(true);
        if (prev[k] !== 0n) expect(g === Gear.REVERSE ? lo <= (prev[k] ?? 0n) : lo >= (prev[k] ?? 0n)).toBe(true);
      });
      prev = gears.map((g) => index(g, r, Rounding.Floor));
    }
  });

  test("pairs price on the ratio", () => {
    const p0 = pairPrice(200n * WAD, 100n * WAD);
    expect(value(Gear.SPORT, pairPrice(220n * WAD, 100n * WAD), p0, WAD, WAD, Rounding.Floor).valueWad).toBe(
      121n * 10n ** 16n,
    );
    expect(value(Gear.SPORT, pairPrice(220n * WAD, 110n * WAD), p0, WAD, WAD, Rounding.Floor).valueWad).toBe(WAD);
  });

  test("shock factor and sqrt", () => {
    expect(shockFactor(Gear.SPORT, 10n ** 17n, Rounding.Floor)).toBe(121n * 10n ** 16n);
    expect(() => shockFactor(Gear.REVERSE, -WAD, Rounding.Floor)).toThrow();
    for (let a = 0n; a < 2000n; a += 7n) {
      const s = sqrt(a);
      expect(s * s <= a && (s + 1n) * (s + 1n) > a).toBe(true);
    }
  });
});

describe("toll (twin of ODToll)", () => {
  test("spec examples", () => {
    const tsla = tollPerYear(Gear.SPORT, 6000n, 0n);
    expect(tsla).toBe(36n * 10n ** 16n);
    expect(Math.abs(pct(perDay(tsla)) - 0.0986)).toBeLessThan(0.0001);
    expect(Math.abs(pct(perDay(tollPerYear(Gear.SPORT, 1800n, 0n))) - 0.00888)).toBeLessThan(0.00001);
    expect(Math.abs(pct(perDay(tollPerYear(Gear.CRUISE, 5000n, 0n))) - 0.0257)).toBeLessThan(0.0001);
    expect(tollPerYear(Gear.ECO, 6000n, 0n) < 0n).toBe(true);
    expect(tollPerYear(Gear.REVERSE, 6000n, 0n)).toBe(tsla);
    expect(tollPerYear(Gear.RACE, 20000n, 0n)).toBe(4n * WAD);
  });

  test("usage, rounding and gap rate", () => {
    const cap = 10n ** 24n;
    expect(usage(0n, cap, WAD)).toBe(0n);
    expect(usage(cap / 2n, cap, 2n * 10n ** 17n)).toBe(5n * 10n ** 16n);
    expect(usage(cap * 2n, cap, WAD)).toBe(WAD);
    expect(perSecond(1n)).toBe(1n);
    expect(perSecond(-1n)).toBe(0n);
    expect(gapRate(-10n, -20n)).toBe(-10n);
  });
});

describe("norm (twin of ODNorm)", () => {
  test("zero dt, bounds, direction", () => {
    expect(normStep(7n * 10n ** 17n, 11415525115n, 0n)).toBe(7n * 10n ** 17n);
    expect(normStep(WAD, MAX_ABS_PER_SEC, 3650n * 86_400n)).toBe(MIN_NF);
    expect(normStep(WAD, -MAX_ABS_PER_SEC, 3650n * 86_400n)).toBe(MAX_NF);
    const day = normStep(WAD, perSecond(tollPerYear(Gear.SPORT, 6000n, 0n)), 86_400n);
    expect(day < WAD).toBe(true);
    expect(Math.abs(Number(day) / 1e18 - Math.exp(-0.36 / 365))).toBeLessThan(1e-7);
  });

  test("matches the naive hourly loop within 2 wei per step", () => {
    for (const [nf, t, dt] of [
      [WAD, 11415525115n, 86_400n],
      [10n ** 24n - 1n, -MAX_ABS_PER_SEC, 5n * 86_400n + 17n],
      [10n ** 10n, MAX_ABS_PER_SEC, 7_201n],
    ] as const) {
      const n = (dt + 3599n) / 3600n;
      const den = n * WAD;
      const num = den - t * dt;
      let loop = nf;
      for (let i = 0n; i < n; i++) loop = (loop * num) / den;
      if (loop < MIN_NF) loop = MIN_NF;
      if (loop > MAX_NF) loop = MAX_NF;
      const got = normStep(nf, t, dt);
      const diff = got > loop ? got - loop : loop - got;
      expect(diff <= 2n * n).toBe(true);
    }
  });

  test("toll value", () => {
    expect(tollValue(10n * WAD, 100n * WAD, WAD, 99n * 10n ** 16n)).toBe(10n * WAD);
    expect(tollValue(10n * WAD, 100n * WAD, WAD, 101n * 10n ** 16n)).toBe(-10n * WAD);
  });
});
