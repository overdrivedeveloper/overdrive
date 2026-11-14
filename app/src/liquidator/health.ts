// Pure health maths, equal to IODBacker.health(). The thresholds (required and maintenance, weekend uplift included) are never
// typed here: they come from the chain per vault on every pass (R2). Ratio rounding: floor, as the interface in todo 01 defines
// ratioBps = collateral / debt value in basis points; a vault with no debt is infinitely healthy.
import { maxUint256 } from "viem";
import { USDG_TO_WAD } from "../lib/fixed";
import type { HealthView } from "./types";

export type { HealthView, VaultView } from "./types";

const BPS = 10_000n;

/** Collateral (USDG, 6 dp) over debt value (WAD) in basis points, rounded down. No debt reads as the uint256 maximum. */
export function ratioBps(collateralUsdg: bigint, debtValueWad: bigint): bigint {
  if (collateralUsdg < 0n || debtValueWad < 0n) throw new RangeError("health inputs must be non-negative");
  if (debtValueWad === 0n) return maxUint256;
  return (collateralUsdg * USDG_TO_WAD * BPS) / debtValueWad;
}

/** Strictly below maintenance is liquidatable; exactly at maintenance is healthy. A vault with no debt is never liquidatable. */
export function isLiquidatable(h: HealthView): boolean {
  if (h.debtValueWad === 0n) return false;
  return h.ratioBps < h.maintenanceBps;
}

/** The chain's health() tuple as a HealthView (viem returns a readonly array for multi-output views). */
export function healthFromTuple(t: readonly [bigint, bigint, bigint, bigint, bigint]): HealthView {
  return { collateralUsdg: t[0], debtValueWad: t[1], ratioBps: t[2], requiredBps: t[3], maintenanceBps: t[4] };
}

/** Our recomputation agrees with what the chain returned (a disagreement means the ABI or units moved: fail closed). */
export function healthConsistent(h: HealthView): boolean {
  return ratioBps(h.collateralUsdg, h.debtValueWad) === h.ratioBps && h.maintenanceBps > 0n && h.requiredBps >= h.maintenanceBps;
}
