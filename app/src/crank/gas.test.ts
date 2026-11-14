import { describe, expect, test } from "bun:test";
import { BATCH_FLOOR, FIXED_GAS, createGasTuner, crankGasLimit, DEFAULT_GAS_LIMIT_POLICY } from "./gas";

describe("gas", () => {
  test("limit_policy", () => {
    const policy = DEFAULT_GAS_LIMIT_POLICY;
    // larger of estimate x 1.5 and estimate + 500k
    expect(crankGasLimit(1_000_000n, policy)).toBe(1_500_000n);
    expect(crankGasLimit(100_000n, policy)).toBe(600_000n);
    // capped
    expect(crankGasLimit(25_000_000n, policy)).toBe(32_000_000n);
    // an estimate above the cap keeps at least estimate x 1.2 (never below the floor)
    expect(crankGasLimit(40_000_000n, policy)).toBe(48_000_000n);
    // always at least estimate x 1.2
    for (const e of [21_000n, 865_000n, 5_000_000n, 31_000_000n]) expect(crankGasLimit(e, { multiplierBps: 12_000, headroom: 0n, cap: 1n })).toBeGreaterThanOrEqual((e * 12n) / 10n);
    expect(crankGasLimit(865_000n, policy)).toBeGreaterThanOrEqual(1_297_500n);
  });

  test("tuner_learns_and_floors", () => {
    const tuner = createGasTuner({ initialBatch: 20, maxBatch: 45, gasTarget: 8_000_000, minBatch: 1 });
    expect(tuner.choose().basis).toBe("seed");
    // 90k per gear measured: the target holds about 8M / (90k x 1.3) = 66 gears, capped at 45 and at 2x growth per run
    tuner.observe(20, BigInt(FIXED_GAS + 90_000 * 20));
    const first = tuner.choose();
    expect(first.batch).toBe(40);
    const second = tuner.choose();
    expect(second.batch).toBe(45);
    // refusals halve the batch but never go below the floor of 10
    for (let i = 0; i < 8; i++) tuner.penalize(45);
    expect(tuner.choose().batch).toBeGreaterThanOrEqual(BATCH_FLOOR);
    // a refusal of a tiny batch says nothing
    const before = tuner.snapshot().lastBatch;
    tuner.penalize(2);
    expect(tuner.snapshot().lastBatch).toBe(before);
  });
});
