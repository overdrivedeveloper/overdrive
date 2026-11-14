// TypeScript twin of contracts/src/math/ODToll.sol: annual toll = p (p - 1) / 2 * sigma^2 + usage, clamped to
// +-400%/yr; per-second and per-day conversions round toward +infinity (always the Governor's side).
import { type Gear, Rounding, WAD, halfPPMinus1Wad, mulDiv } from "./index";

export const YEAR = 365n * 86_400n;
export const MAX_ABS_TOLL_PER_YEAR = 4n * WAD;

/** Signed division rounded toward +infinity (Solidity ODToll.ceilDiv). */
function ceilDiv(a: bigint, d: bigint): bigint {
  let q = a / d; // bigint division truncates toward zero, like Solidity
  if (a > 0n && q * d !== a) q += 1n;
  return q;
}

export function tollPerYear(g: Gear, sigmaBps: bigint, usageWad: bigint): bigint {
  if (sigmaBps < 0n || sigmaBps >= 1n << 64n) throw new RangeError("sigmaBps: out of uint64 range");
  if (usageWad < 0n) throw new RangeError("usageWad: negative");
  const s2 = sigmaBps * sigmaBps * 10n ** 10n;
  let t = (halfPPMinus1Wad(g) * s2) / WAD;
  const u = usageWad > 2n * MAX_ABS_TOLL_PER_YEAR ? 2n * MAX_ABS_TOLL_PER_YEAR : usageWad;
  t += u;
  if (t > MAX_ABS_TOLL_PER_YEAR) t = MAX_ABS_TOLL_PER_YEAR;
  if (t < -MAX_ABS_TOLL_PER_YEAR) t = -MAX_ABS_TOLL_PER_YEAR;
  return t;
}

/** usageMax * u^2, u = min(1, open / cap), rounded up; zero when nothing is open. */
export function usage(openValueWad: bigint, capWad: bigint, usageMaxWad: bigint): bigint {
  if (openValueWad === 0n) return 0n;
  if (openValueWad >= capWad) return usageMaxWad;
  const x = mulDiv(usageMaxWad, openValueWad, capWad, Rounding.Ceil);
  return mulDiv(x, openValueWad, capWad, Rounding.Ceil);
}

export function perSecond(perYearWad: bigint): bigint {
  return ceilDiv(perYearWad, YEAR);
}

export function perDay(perYearWad: bigint): bigint {
  return ceilDiv(perYearWad, 365n);
}

export function gapRate(storedPerSec: bigint, currentPerSec: bigint): bigint {
  return storedPerSec > currentPerSec ? storedPerSec : currentPerSec;
}
