import { describe, expect, test } from "bun:test";
import { divWad, fixed, fromBps, mulWad, parseUsdg, toBigInt, usdgDecimal, usdgToWad, WAD, wadToUsdg, wadToUsdgUp } from "./fixed";

describe("fixed", () => {
  test("the USDG boundary is exact one way and rounds explicitly the other", () => {
    expect(usdgToWad(1_500_000n)).toBe(1_500_000n * 10n ** 12n);
    expect(wadToUsdg(usdgToWad(123_456_789n))).toBe(123_456_789n);
    expect(wadToUsdg(10n ** 12n - 1n)).toBe(0n);
    expect(wadToUsdgUp(10n ** 12n - 1n)).toBe(1n);
    expect(wadToUsdgUp(-(10n ** 12n - 1n))).toBe(-1n);
    expect(wadToUsdgUp(0n)).toBe(0n);
  });
  test("fuzz: round trips and mul/div stay consistent", () => {
    let seed = 7n;
    const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
    for (let i = 0; i < 500; i++) {
      const usdg = next() % 10n ** 15n;
      expect(wadToUsdg(usdgToWad(usdg))).toBe(usdg);
      const a = next() % 10n ** 30n;
      const b = (next() % 10n ** 20n) + 1n;
      expect(mulWad(a, WAD)).toBe(a);
      expect(divWad(mulWad(a, b), b) <= a).toBe(true);
      expect(wadToUsdgUp(a) >= wadToUsdg(a)).toBe(true);
    }
  });
  test("parsing", () => {
    expect(fixed("1.5")).toBe(15n * 10n ** 17n);
    expect(fixed(null)).toBe(0n);
    expect(parseUsdg("2.5")).toBe(2_500_000n);
    expect(usdgDecimal(2_500_000n)).toBe("2.5");
    expect(fromBps(10_000n, 30)).toBe(30n);
    expect(toBigInt("123.000")).toBe(123n);
    expect(toBigInt(null)).toBe(0n);
    expect(divWad(1n, 0n)).toBe(0n);
  });
});
