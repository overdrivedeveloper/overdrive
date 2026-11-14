// Economics (R8): a batch is sent only when the sum of bonuses pays for its gas several times over. Gas price and the ETH price
// are read live. Vaults too small to pay their own share wait and are listed as `uneconomic` so the owner can see dust.
import { mulWad, wadToUsdgUp } from "../lib/fixed";
import type { HealthView } from "./types";

/** Liquidation terms read from ODBacker (BONUS_BPS, MIN_REWARD_USDG), never typed here. */
export interface LiquidationTerms { bonusBps: bigint; minRewardUsdg: bigint }

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The contract's split of one vault (ODLiquidation), from the vault's own collateral only (no insurance, no stake):
 * D = debt value in USDG rounded up, bonus due B = floor(bonusBps of D), the Governor receives min(collateral - B, D),
 * what is left of D + B stays in the vault. */
export function expectedSplit(h: Pick<HealthView, "collateralUsdg" | "debtValueWad">, t: LiquidationTerms) {
  const debtUsdg = wadToUsdgUp(h.debtValueWad);
  const bonusDue = (debtUsdg * t.bonusBps) / BPS;
  const fromCollateral = min(bonusDue, h.collateralUsdg);
  const floor = min(bonusDue, t.minRewardUsdg);
  const toGovernor = min(h.collateralUsdg - fromCollateral, debtUsdg);
  return {
    debtUsdg,
    bonusDue,
    /** What the executor can count on: the bonus paid from collateral, never below the floor min(B, MIN_REWARD_USDG). */
    bonusUsdg: fromCollateral > floor ? fromCollateral : floor,
    toGovernorUsdg: toGovernor,
    seizedUsdg: min(h.collateralUsdg, debtUsdg + bonusDue),
    shortfallUsdg: debtUsdg + bonusDue > h.collateralUsdg ? debtUsdg + bonusDue - h.collateralUsdg : 0n,
  };
}

/** Expected collateral seized: D + B, capped by the vault's collateral. */
export function expectedSeizedUsdg(h: Pick<HealthView, "collateralUsdg" | "debtValueWad">, t: LiquidationTerms): bigint {
  return expectedSplit(h, t).seizedUsdg;
}

/** Expected bonus: bonusBps of the debt value (rounded down), from collateral, at least the contract's minimum reward floor. */
export function expectedBonusUsdg(h: Pick<HealthView, "collateralUsdg" | "debtValueWad">, t: LiquidationTerms): bigint {
  return expectedSplit(h, t).bonusUsdg;
}

/** Gas cost in USDG (6 dp, rounded up): gas units times wei per gas is ETH in WAD, times the ETH price in WAD. */
export function gasCostUsdg(gas: bigint, gasPriceWei: bigint, ethPriceWad: bigint): bigint {
  return wadToUsdgUp(mulWad(gas * gasPriceWei, ethPriceWad));
}

export interface EconomicsInput {
  vaults: readonly { vaultId: bigint; bonusUsdg: bigint }[];
  /** Total gas of seal plus execute for the whole set. */
  gasEstimate: bigint;
  gasCostUsdg: bigint;
  minBonusUsdg: bigint;
  /** Bonus must be at least gas cost times this, in basis points (a multiple of 2 is twice BPS). */
  gasMultipleBps: bigint;
}

export interface EconomicsResult { send: bigint[]; uneconomic: bigint[]; bonusUsdg: bigint; requiredUsdg: bigint; ok: boolean; reason?: string }

/** Drops vaults whose bonus does not pay for their per-vault share of gas (times the multiple), then tests the whole batch. */
export function decideEconomics(input: EconomicsInput): EconomicsResult {
  const n = BigInt(input.vaults.length);
  if (n === 0n) return { send: [], uneconomic: [], bonusUsdg: 0n, requiredUsdg: 0n, ok: false, reason: "empty" };
  const perVaultNeed = ceilDiv(input.gasCostUsdg * input.gasMultipleBps, BPS * n);
  const send: { vaultId: bigint; bonusUsdg: bigint }[] = [];
  const uneconomic: bigint[] = [];
  for (const v of input.vaults) {
    if (v.bonusUsdg >= perVaultNeed) send.push(v);
    else uneconomic.push(v.vaultId);
  }
  const bonus = send.reduce((s, v) => s + v.bonusUsdg, 0n);
  const kept = BigInt(send.length);
  // Gas of the smaller batch, scaled linearly (the fixed part is conservative: it stays with the batch).
  const gasCost = kept === 0n ? 0n : ceilDiv(input.gasCostUsdg * kept, n);
  const requiredByGas = ceilDiv(gasCost * input.gasMultipleBps, BPS);
  const required = requiredByGas > input.minBonusUsdg ? requiredByGas : input.minBonusUsdg;
  if (kept === 0n) return { send: [], uneconomic: input.vaults.map((v) => v.vaultId), bonusUsdg: 0n, requiredUsdg: required, ok: false, reason: "every vault is dust" };
  if (bonus < required) {
    return { send: [], uneconomic: input.vaults.map((v) => v.vaultId), bonusUsdg: bonus, requiredUsdg: required, ok: false, reason: `bonus ${bonus} below required ${required}` };
  }
  return { send: send.map((v) => v.vaultId), uneconomic, bonusUsdg: bonus, requiredUsdg: required, ok: true };
}
