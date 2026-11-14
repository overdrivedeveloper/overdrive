// TypeScript twin of contracts/src/math/ODNorm.sol: NF <- NF * (1 - toll * dt / n)^n, n = ceil(dt / 1 hour),
// the factor formed at 1e36 and raised by squaring, every step rounded down, clamped to [MIN_NF, MAX_NF].
import { mulDiv } from "./index";

export const STEP = 3_600n;
export const MIN_NF = 10n ** 9n;
export const MAX_NF = 10n ** 24n;
const R36 = 10n ** 36n;
export const MAX_ABS_PER_SEC = 126_839_167_936n; // ceil(4e18 / 365 days)
const POW_CAP = 10n ** 54n;
const UINT128_MAX = (1n << 128n) - 1n;

function pow36(base: bigint, n: bigint): bigint {
  let z = R36;
  let b = base;
  while (n > 0n) {
    if ((n & 1n) === 1n) {
      z = mulDiv(z, b, R36);
      if (z > POW_CAP) z = POW_CAP;
      if (z === 0n) return 0n;
    }
    n >>= 1n;
    if (n > 0n) {
      b = mulDiv(b, b, R36);
      if (b > POW_CAP) b = POW_CAP;
    }
  }
  return z;
}

export function normStep(nf: bigint, tollPerSecWad: bigint, dt: bigint): bigint {
  if (nf < 0n || dt < 0n) throw new RangeError("normStep: negative input");
  if (dt === 0n || tollPerSecWad === 0n) return nf;
  if (tollPerSecWad > 0n && nf <= MIN_NF) return nf;
  if (tollPerSecWad < 0n && nf >= MAX_NF) return nf;
  if (dt > UINT128_MAX) dt = UINT128_MAX;
  let t = tollPerSecWad;
  if (t > MAX_ABS_PER_SEC) t = MAX_ABS_PER_SEC;
  if (t < -MAX_ABS_PER_SEC) t = -MAX_ABS_PER_SEC;
  const n = (dt + STEP - 1n) / STEP;
  const num = R36 * n - t * 10n ** 18n * dt;
  const f36 = num / n;
  let out = mulDiv(nf, pow36(f36, n), R36);
  if (out < MIN_NF) out = MIN_NF;
  if (out > MAX_NF) out = MAX_NF;
  return out;
}

/** tokens * v * (1 - nfNew / nf), magnitude rounded down; positive = paid by holders. */
export function tollValue(tokens: bigint, vBeforeWad: bigint, nf: bigint, nfNew: bigint): bigint {
  if (nf === 0n || nf === nfNew) return 0n;
  const v = mulDiv(tokens, vBeforeWad, 10n ** 18n);
  if (nfNew < nf) return mulDiv(v, nf - nfNew, nf);
  return -mulDiv(v, nfNew - nf, nf);
}
