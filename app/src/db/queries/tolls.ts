import { WAD } from "../../lib/fixed";

export const SECONDS_PER_DAY = 86_400n;
/** Sigma older than this (seconds) is shown as `floor` with a warning (never hidden). */
export const SIGMA_MAX_AGE_SEC = 7_200;

/** The TypeScript twin of the toll formula (PENDING todo 03's app/src/pricing/toll.ts, which replaces it):
 * 0.5 x p x (p - 1) x sigma^2 / 365 + usage, per day, as a WAD fraction. p and usage in WAD, sigma in bps. Eco (p = 0.5) is negative. */
export function tollPerDayTwinWad(powerWad: bigint, sigmaBps: bigint, usagePerDayWad = 0n): bigint {
  const sigma2Wad = (sigmaBps * sigmaBps * WAD) / 100_000_000n; // (bps/1e4)^2 in WAD
  const pp = (powerWad * (powerWad - WAD)) / WAD; // p(p-1) in WAD
  return (pp * sigma2Wad) / WAD / 2n / 365n + usagePerDayWad;
}
