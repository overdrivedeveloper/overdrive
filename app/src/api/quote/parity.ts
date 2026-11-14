import type { RawQuote } from "./model";

const FIELDS: readonly (keyof RawQuote)[] = ["amountIn", "amountOut", "valuePerTokenWad", "pricePerTokenWad", "spreadBps", "protocolFeeUsdg", "tollPerDayWad", "session", "queued"];

/** Field by field, zero tolerance. A field either side does not provide (null) is not compared. Returns the names that differ. */
export function parityFailures(a: RawQuote, b: RawQuote): string[] {
  const out: string[] = [];
  for (const field of FIELDS) {
    const left = a[field];
    const right = b[field];
    if (left === null || right === null || left === undefined || right === undefined) continue;
    if (left !== right) out.push(field);
  }
  return out;
}
