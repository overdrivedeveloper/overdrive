// TypeScript twin of contracts/src/math/ODIndex.sol (and the ODFixed helpers it uses). Every function works on
// bigint WAD values with the same rounding as the Solidity library, so results are equal to the wei; the vector
// files in contracts/test/vectors prove it on both sides.

export const WAD = 10n ** 18n;
export const MIN_R = 2n * 10n ** 16n; // 0.02: -98%
export const MAX_R = 50n * WAD; // 50: +4,900%

/** Same numbering as the Solidity enum `Gear`. */
export enum Gear {
  CRUISE = 0, // p = 1.5
  SPORT = 1, // p = 2
  RACE = 2, // p = 3
  ECO = 3, // p = 0.5
  REVERSE = 4, // p = -1
}

/** Same numbering as OpenZeppelin `Math.Rounding` (only Floor and Ceil are used for pricing). */
export enum Rounding {
  Floor = 0,
  Ceil = 1,
}

export class RatioZeroError extends Error {
  constructor() {
    super("RatioZero");
  }
}

export class ShockOutOfRangeError extends Error {
  constructor(shock: bigint) {
    super(`ShockOutOfRange(${shock})`);
  }
}

const UINT256_MAX = (1n << 256n) - 1n;

function checkUint(x: bigint, what: string): bigint {
  if (x < 0n || x > UINT256_MAX) throw new RangeError(`${what}: out of uint256 range`);
  return x;
}

/** OpenZeppelin Math.mulDiv(a, b, d, rounding). */
export function mulDiv(a: bigint, b: bigint, d: bigint, rnd: Rounding = Rounding.Floor): bigint {
  if (d === 0n) throw new RangeError("mulDiv: division by zero");
  const prod = checkUint(a, "mulDiv a") * checkUint(b, "mulDiv b");
  let q = prod / d;
  if (rnd === Rounding.Ceil && prod % d !== 0n) q += 1n;
  return checkUint(q, "mulDiv result");
}

/** OpenZeppelin Math.sqrt(a, rounding). */
export function sqrt(a: bigint, rnd: Rounding = Rounding.Floor): bigint {
  checkUint(a, "sqrt");
  if (a < 2n) return a;
  let x = 1n << BigInt(Math.ceil(a.toString(2).length / 2)); // >= sqrt(a)
  for (;;) {
    const y = (x + a / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  if (rnd === Rounding.Ceil && x * x < a) x += 1n;
  return x;
}

export function mulWad(a: bigint, b: bigint, rnd: Rounding): bigint {
  return mulDiv(a, b, WAD, rnd);
}

export function divWad(a: bigint, b: bigint, rnd: Rounding): bigint {
  return mulDiv(a, WAD, b, rnd);
}

/** ODFixed.sqrtWad: sqrt(x * 1e18). */
export function sqrtWad(x: bigint, rnd: Rounding): bigint {
  if (x <= UINT256_MAX / WAD) return sqrt(x * WAD, rnd);
  return sqrt(x, rnd) * 10n ** 9n;
}

export function opposite(rnd: Rounding): Rounding {
  return rnd === Rounding.Floor ? Rounding.Ceil : Rounding.Floor;
}

/** r = p / p0 (WAD), clamped into [MIN_R, MAX_R]; inDomain = false when clamped. */
export function ratio(p: bigint, p0: bigint, rnd: Rounding): { r: bigint; inDomain: boolean } {
  if (p === 0n || p0 === 0n) throw new RatioZeroError();
  const r = mulDiv(p, WAD, p0, rnd);
  if (r < MIN_R) return { r: MIN_R, inDomain: false };
  if (r > MAX_R) return { r: MAX_R, inDomain: false };
  return { r, inDomain: true };
}

/** Price of A in units of B (WAD) for a pair gear, rounded down. */
export function pairPrice(pA: bigint, pB: bigint): bigint {
  if (pA === 0n || pB === 0n) throw new RatioZeroError();
  return mulDiv(pA, WAD, pB, Rounding.Floor);
}

/** I = r^power in closed form, exactly rounded in `rnd`. */
export function index(g: Gear, r: bigint, rnd: Rounding): bigint {
  switch (g) {
    case Gear.SPORT:
      return mulDiv(r, r, WAD, rnd);
    case Gear.RACE:
      return mulDiv(checkUint(r * r, "r*r"), r, WAD * WAD, rnd);
    case Gear.CRUISE:
      return sqrt(mulDiv(checkUint(r * r, "r*r"), r, WAD, rnd), rnd);
    case Gear.ECO:
      return sqrtWad(r, rnd);
    case Gear.REVERSE:
      return mulDiv(WAD, WAD, r, rnd);
  }
}

/** Value per token (USD WAD) = nf * I * unit / 1e36, one rounding direction end to end. */
export function value(
  g: Gear,
  p: bigint,
  p0: bigint,
  nf: bigint,
  unitWad: bigint,
  rnd: Rounding,
): { valueWad: bigint; inDomain: boolean } {
  const { r, inDomain } = ratio(p, p0, g === Gear.REVERSE ? opposite(rnd) : rnd);
  const i = index(g, r, rnd);
  return { valueWad: mulDiv(checkUint(nf * i, "nf*I"), unitWad, WAD * WAD, rnd), inDomain };
}

/** (1 + shock)^power, shock a signed WAD in (-1e18, MAX_R]. */
export function shockFactor(g: Gear, shockWad: bigint, rnd: Rounding): bigint {
  if (shockWad <= -WAD || shockWad > MAX_R) throw new ShockOutOfRangeError(shockWad);
  return index(g, WAD + shockWad, rnd);
}

/** p (p - 1) / 2 as a signed WAD. */
export function halfPPMinus1Wad(g: Gear): bigint {
  switch (g) {
    case Gear.CRUISE:
      return 375n * 10n ** 15n;
    case Gear.SPORT:
      return WAD;
    case Gear.RACE:
      return 3n * WAD;
    case Gear.ECO:
      return -125n * 10n ** 15n;
    case Gear.REVERSE:
      return WAD;
  }
}
