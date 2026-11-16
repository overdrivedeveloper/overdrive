import { expect, test } from "bun:test";
import { hasPerk, missingForNext, thresholdsOf, tierOf, TIER_PERKS } from "./holder-tiers";

const t = thresholdsOf({ HOLDER_TIER_HOLDER_MIN: 100_000, HOLDER_TIER_WHALE_MIN: 1_000_000 });
const tok = (n: bigint, dec = 18) => n * 10n ** BigInt(dec);

test("tier boundaries are inclusive and exact", () => {
  expect(tierOf(0n, 18, t)).toBe("none");
  expect(tierOf(tok(100_000n) - 1n, 18, t)).toBe("none");
  expect(tierOf(tok(100_000n), 18, t)).toBe("holder");
  expect(tierOf(tok(1_000_000n) - 1n, 18, t)).toBe("holder");
  expect(tierOf(tok(1_000_000n), 18, t)).toBe("whale");
  expect(tierOf(tok(100_000n, 6), 6, t)).toBe("holder"); // decimals are read, not assumed
});
test("perks nest and the core is not a perk", () => {
  expect(TIER_PERKS.none).toEqual([]);
  for (const p of TIER_PERKS.holder) expect(TIER_PERKS.whale).toContain(p);
  expect(hasPerk("holder", "agent_tools")).toBe(false);
  expect(hasPerk("whale", "agent_tools")).toBe(true);
  expect(JSON.stringify(TIER_PERKS)).not.toMatch(/toll/i);
});
test("missing amount rounds up and ends at the top", () => {
  expect(missingForNext(tok(99_999n) + 1n, 18, t)).toEqual({ next: "holder", missingTokens: "1" });
  expect(missingForNext(tok(100_000n), 18, t)).toEqual({ next: "whale", missingTokens: "900000" });
  expect(missingForNext(tok(2_000_000n), 18, t)).toBeNull();
});
test("whale threshold below holder threshold is refused", () => {
  expect(() => thresholdsOf({ HOLDER_TIER_HOLDER_MIN: 10, HOLDER_TIER_WHALE_MIN: 5 })).toThrow();
});
