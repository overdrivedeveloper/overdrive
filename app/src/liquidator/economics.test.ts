import { describe, expect, test } from "bun:test";
import { WAD } from "../testing/mock-chain";
import { decideEconomics, expectedBonusUsdg, expectedSeizedUsdg, expectedSplit, gasCostUsdg } from "./economics";

const TERMS = { bonusBps: 500n, minRewardUsdg: 1_000_000n }; // as ODBacker reports them

const U = 10n ** 6n;

describe("economics (R8)", () => {
  test("bonus_vs_gas_threshold", () => {
    // 400k gas at 1 gwei with ETH at 3000 USD costs 1.2 USDG
    const cost = gasCostUsdg(400_000n, 10n ** 9n, 3000n * WAD);
    expect(cost).toBe(1_200_000n);
    const base = { gasEstimate: 400_000n, gasCostUsdg: cost, minBonusUsdg: 1n * U, gasMultipleBps: 2n * 10_000n };
    // 2.4 USDG of bonus is exactly twice the gas: sent
    expect(decideEconomics({ ...base, vaults: [{ vaultId: 1n, bonusUsdg: 2_400_000n }] }).ok).toBe(true);
    // one unit less: waits
    const short = decideEconomics({ ...base, vaults: [{ vaultId: 1n, bonusUsdg: 2_399_999n }] });
    expect(short.ok).toBe(false);
    expect(short.send).toEqual([]);
    // the minimum bonus binds when gas is nearly free
    expect(decideEconomics({ ...base, gasCostUsdg: 1n, vaults: [{ vaultId: 1n, bonusUsdg: U - 1n }] }).ok).toBe(false);
    expect(decideEconomics({ ...base, gasCostUsdg: 1n, vaults: [{ vaultId: 1n, bonusUsdg: U }] }).ok).toBe(true);
    // ODBacker's split: bonus 5% of the DEBT VALUE, the Governor gets min(collateral - bonus, debt), the rest stays
    const h = { collateralUsdg: 1000n * U, debtValueWad: 95n * WAD };
    expect(expectedBonusUsdg(h, TERMS)).toBe(4_750_000n);
    expect(expectedSeizedUsdg(h, TERMS)).toBe(99_750_000n);
    expect(expectedSplit(h, TERMS).toGovernorUsdg).toBe(95n * U);
    // under water: bonus first from collateral, the Governor takes what is left, the shortfall is the gap
    const deep = expectedSplit({ collateralUsdg: 10n * U, debtValueWad: 95n * WAD }, TERMS);
    expect(deep).toMatchObject({ bonusUsdg: 4_750_000n, toGovernorUsdg: 5_250_000n, seizedUsdg: 10n * U, shortfallUsdg: 89_750_000n });
    // debt value rounds UP to the USDG unit, the bonus DOWN
    expect(expectedSplit({ collateralUsdg: 1000n * U, debtValueWad: 1n }, TERMS)).toMatchObject({ debtUsdg: 1n, bonusDue: 0n });
    // the minimum reward floor: min(B, MIN_REWARD_USDG) even when collateral cannot pay it
    expect(expectedBonusUsdg({ collateralUsdg: 100n, debtValueWad: 1000n * WAD }, TERMS)).toBe(U);
    expect(expectedBonusUsdg({ collateralUsdg: 0n, debtValueWad: 10n * WAD }, TERMS)).toBe(500_000n);
    // the terms are the chain's: a different BONUS_BPS changes the number
    expect(expectedBonusUsdg(h, { ...TERMS, bonusBps: 1000n })).toBe(9_500_000n);
  });

  test("dust_vaults_listed_not_sent", () => {
    const vaults = [
      { vaultId: 1n, bonusUsdg: 50n * U },
      { vaultId: 2n, bonusUsdg: 1n },
      { vaultId: 3n, bonusUsdg: 40n * U },
      { vaultId: 4n, bonusUsdg: 10n },
    ];
    const r = decideEconomics({ vaults, gasEstimate: 1_000_000n, gasCostUsdg: 4n * U, minBonusUsdg: U, gasMultipleBps: 2n * 10_000n });
    expect(r.ok).toBe(true);
    expect(r.send).toEqual([1n, 3n]);
    expect(r.uneconomic).toEqual([2n, 4n]);
    // all dust: nothing is sent, all listed
    const dust = decideEconomics({ vaults: [{ vaultId: 7n, bonusUsdg: 5n }, { vaultId: 8n, bonusUsdg: 6n }], gasEstimate: 1n, gasCostUsdg: 4n * U, minBonusUsdg: U, gasMultipleBps: 2n * 10_000n });
    expect(dust.ok).toBe(false);
    expect(dust.send).toEqual([]);
    expect(dust.uneconomic).toEqual([7n, 8n]);
  });
});
