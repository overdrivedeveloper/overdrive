import { describe, expect, test } from "bun:test";
import { WAD } from "../testing/mock-chain";
import { BONUS_BPS, decideEconomics, expectedBonusUsdg, expectedSeizedUsdg, gasCostUsdg } from "./economics";

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
    // a 5% bonus on seized collateral
    const h = { collateralUsdg: 1000n * U, debtValueWad: 95n * WAD };
    expect(expectedSeizedUsdg(h)).toBe(100n * U);
    expect(expectedBonusUsdg(h)).toBe((100n * U * BONUS_BPS) / 10_000n);
    expect(expectedSeizedUsdg({ collateralUsdg: 10n * U, debtValueWad: 95n * WAD })).toBe(10n * U);
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
