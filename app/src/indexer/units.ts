import type { Address, Hex } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

export function asBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|\d+)$/i.test(value)) return BigInt(value);
  return fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export const asAddress = (value: unknown): Address => String(value).toLowerCase() as Address;
export const asHex32 = (value: unknown): Hex => String(value).toLowerCase() as Hex;
export const blockHex = (value: bigint): Hex => `0x${value.toString(16)}`;

/** A header timestamp (hex quantity, number or bigint, seconds) as a Date, or undefined when it is not one. */
export function parseChainTimestamp(value: unknown): Date | undefined {
  const seconds = asBigInt(value, -1n);
  return seconds < 0n ? undefined : new Date(Number(seconds) * 1000);
}

/** Gear enum (ODTypes.Gear) names and their power in WAD. */
export const GEAR_NAMES = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"] as const;
export const GEAR_POWER_WAD = [1_500_000_000_000_000_000n, 2_000_000_000_000_000_000n, 3_000_000_000_000_000_000n, 500_000_000_000_000_000n, -1_000_000_000_000_000_000n] as const;
export const GEAR_POWER_TEXT = ["1.5", "2", "3", "0.5", "-1"] as const;

/** ODTypes.GearStatus: NONE, LISTED, BUYS_PAUSED, SELL_ONLY, SETTLED. */
export function gearStatusName(value: unknown): "active" | "paused" | "retired" {
  const n = asNumber(value, 0);
  return n === 1 ? "active" : n === 4 ? "retired" : "paused";
}

const SESSIONS = ["OPEN", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"] as const;
export const sessionName = (value: unknown): string => SESSIONS[asNumber(value, -1)] ?? "UNKNOWN";

/** bytes32 text (right padded) to a short string, e.g. a pause reason. */
export function bytes32Text(value: unknown): string {
  const hex = String(value).replace(/^0x/, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    out += code >= 32 && code < 127 ? String.fromCharCode(code) : "?";
  }
  return out;
}
