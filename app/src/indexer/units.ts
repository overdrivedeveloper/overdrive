import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

// IDS-1: the ONE place the app turns market ids (bytes32 ASCII), pair keys and bytes32 reason text to and from strings.
// src/indexer/ids-guard.test.ts fails on an ad-hoc bytes32 encode or decode anywhere else in app/; the vectors in
// contracts/test/vectors/market-ids.json pin both directions (vol-engine and risk-sim keep their own, same vectors).

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

/** bytes32 text (right padded) to a short string, e.g. a pause reason. Zero (no reason) is "". */
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

/** A market id (bytes32, the symbol's ASCII right padded with zeros) to its symbol, for markets the deployment file does not
 *  list yet (listed later through the timelock). Anything that is not a clean printable-ASCII id is returned unchanged. */
export function marketSymbol(id: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return id;
  const raw = Buffer.from(id.slice(2), "hex");
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  if (end === 0) return id;
  const body = raw.subarray(0, end);
  for (const b of body) if (b <= 0x20 || b >= 0x7f) return id;
  return body.toString("ascii");
}

/** A market symbol to its id: the symbol's ASCII right padded with zeros to 32 bytes (SystemConfig.sol m.id).
 *  Throws on an empty symbol, one over 32 bytes, or any byte outside printable ASCII. */
export function marketId(symbol: string): Hex {
  if (!/^[\x21-\x7e]{1,32}$/.test(symbol)) throw new Error(`not a market symbol: ${JSON.stringify(symbol)}`);
  return `0x${Buffer.from(symbol, "ascii").toString("hex").padEnd(64, "0")}` as Hex;
}

/** bytes32 of short text (a reason or tag), right padded; same encoding as marketId, any printable ASCII up to 32. */
export const bytes32OfText = (text: string): Hex => marketId(text);

/** Key of a pair: numerator market `a` over denominator market `b`, keccak256(abi.encode(a, b)) (ODVolOracle.pairKey). */
export function pairKey(a: Hex, b: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [a, b]));
}
