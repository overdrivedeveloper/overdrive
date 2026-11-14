// The one boundary between chain units and service units (invariant 4): on-chain values are WAD (1e18); USDG token amounts
// are 6 dp. Services convert only through these functions. Everything is bigint; numeric columns hold the raw integer.
import { formatUnits, parseUnits } from "viem";

export const WAD = 10n ** 18n;
export const USDG_DECIMALS = 6;
/** 1e12: WAD per USDG base unit. */
export const USDG_TO_WAD = 10n ** BigInt(18 - USDG_DECIMALS);

/** Raw USDG (6 dp) to WAD (18 dp), exact. */
export const usdgToWad = (usdg: bigint): bigint => usdg * USDG_TO_WAD;
/** WAD to raw USDG (6 dp), rounding toward zero. */
export const wadToUsdg = (wad: bigint): bigint => wad / USDG_TO_WAD;
/** WAD to raw USDG rounding away from zero (use where a payer must not be short). */
export const wadToUsdgUp = (wad: bigint): bigint => (wad >= 0n ? (wad + USDG_TO_WAD - 1n) / USDG_TO_WAD : -((-wad + USDG_TO_WAD - 1n) / USDG_TO_WAD));

/** Decimal string or number to WAD. null, undefined and "" are 0. */
export function fixed(value: string | number | bigint | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined || value === "") return 0n;
  return parseUnits(String(value), 18);
}
export const decimal = (value: bigint): string => formatUnits(value, 18);
export const usdgDecimal = (value: bigint): string => formatUnits(value, USDG_DECIMALS);
export const parseUsdg = (value: string): bigint => parseUnits(value, USDG_DECIMALS);

/** a * b / WAD, rounding toward zero. */
export const mulWad = (a: bigint, b: bigint): bigint => (a * b) / WAD;
/** a * WAD / b, rounding toward zero; division by zero is 0n (callers check first when it matters). */
export const divWad = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : (a * WAD) / b);
export const fromBps = (value: bigint, bps: number | bigint): bigint => (value * BigInt(bps)) / 10_000n;

/** A numeric(78,0) column value (string, number or bigint) as bigint. */
export function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;
  return BigInt(typeof value === "number" ? Math.trunc(value) : value.includes(".") ? value.split(".")[0]! : value);
}
