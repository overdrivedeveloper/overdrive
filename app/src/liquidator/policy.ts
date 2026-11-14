// Price policy (R4, STALE-1): a wrongful liquidation takes a backer's collateral, so the service fails closed on the price. It never
// computes a price of its own: the verdict is always the contract's health(); this module only decides whether the oracle guard's
// reading of the market is trustworthy enough to let that verdict act.
import { hexToString, type Hex } from "viem";
import type { PriceReading, Verdict } from "./types";

/** Session enum of ODTypes.sol: OPEN, EXTENDED, CLOSED, ... Anything other than OPEN or EXTENDED is "closed" for this service. */
export const SESSION_OPEN = 0;
export const SESSION_EXTENDED = 1;

/** Pause reasons that make the price itself doubtful. MANUAL and DISABLED pause buys only; liquidation of existing vaults goes on. */
const FAIL_CLOSED_REASONS: Record<string, Verdict> = {
  HALTED: "halted",
  SPLIT_PENDING: "split_pending",
  CONTINUITY: "continuity",
  REF_UNAVAILABLE: "no_reference",
  REF_BAND: "ref_band",
};

export function reasonText(reason: Hex): string {
  if (!reason || /^0x0*$/.test(reason)) return "";
  try { return hexToString(reason, { size: 32 }).replace(/\0+$/, ""); } catch { return reason; }
}

export interface PriceDecision { ok: boolean; verdict?: Verdict; reason?: string; closed: boolean }

/** May a vault on this market be verified at all? Closed markets pass (the contract's held price and weekend uplift decide). */
export function priceDecision(reading: PriceReading): PriceDecision {
  const closed = reading.session !== SESSION_OPEN && reading.session !== SESSION_EXTENDED;
  if (!reading.fresh) return { ok: false, verdict: "stale", reason: "oracle reading not fresh", closed };
  const text = reasonText(reading.reason);
  if (reading.buysPaused && FAIL_CLOSED_REASONS[text]) return { ok: false, verdict: FAIL_CLOSED_REASONS[text], reason: `buys paused: ${text}`, closed };
  if (reading.refP === 0n) return { ok: false, verdict: "no_reference", reason: "reference price unavailable", closed };
  if (reading.p === 0n) return { ok: false, verdict: "stale", reason: "zero price", closed };
  return { ok: true, closed };
}

/** Pair gears read both legs: the first failing leg decides. */
export function combinedDecision(readings: readonly PriceReading[]): PriceDecision {
  let closed = false;
  for (const reading of readings) {
    const d = priceDecision(reading);
    if (!d.ok) return d;
    closed ||= d.closed;
  }
  return { ok: readings.length > 0, closed, ...(readings.length ? {} : { verdict: "read_failed" as const, reason: "no market reading" }) };
}
