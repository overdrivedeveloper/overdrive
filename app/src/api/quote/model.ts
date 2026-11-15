// Pure rules of the quote layer: what a raw quote means, which revert is which API code, and the closed-market sell rule.
// No I/O here, so every rule has a table test.
import { formatUnits } from "viem";
import { bytes32Text } from "../../indexer/units";
import { decodeRevert } from "../../chain/revert";

export type Side = "buy" | "sell";
export type SellMode = "instant" | "instant_min" | "queued";
export const SESSION_NAMES = ["OPEN", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"] as const;
export type SessionName = (typeof SESSION_NAMES)[number];
export const sessionOf = (value: number): SessionName => SESSION_NAMES[value] ?? "UNKNOWN";

/** The contract's `Quote` struct. A field a source does not provide (V4Quoter returns amounts only) is null and is skipped by parity. */
export interface RawQuote {
  amountIn: bigint;
  amountOut: bigint;
  valuePerTokenWad: bigint | null;
  pricePerTokenWad: bigint | null;
  spreadBps: number | null;
  protocolFeeUsdg: bigint | null;
  tollPerDayWad: bigint | null;
  session: number | null;
  queued: boolean;
}
export type BlockQuote = RawQuote & { blockNumber: bigint };

export const ERROR_CODES = ["BAD_REQUEST", "NOT_FOUND", "RATE_LIMITED", "STALE", "PAUSED", "CLOSED", "CAP_REACHED", "BELOW_MIN", "RESERVE_FLOOR", "UPSTREAM"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Refusal { code: ErrorCode | "QUEUED"; reason: string; detail?: string }

/** A contract revert (decoded name and arguments) as the API reports it. Unknown reverts fail closed as UPSTREAM. */
export function classifyRevert(name: string, args: readonly unknown[]): Refusal {
  switch (name) {
    case "UnexpectedRevertBytes":
    case "WrappedError": {
      // Uniswap v4 wrappers around the hook's revert: classify the inner error (its revert data is args[0] or args[2]).
      const data = name === "WrappedError" ? args[2] : args[0];
      const inner = typeof data === "string" ? decodeRevert({ data }) : undefined;
      return inner ? classifyRevert(inner.name, inner.args) : { code: "UPSTREAM", reason: name };
    }
    case "BuysClosed": {
      const reason = bytes32Text(args[1]) || "UNKNOWN";
      if (reason === "STALE" || reason === "REF_UNAVAILABLE") return { code: "STALE", reason };
      if (reason === "CLOSED" || reason === "HALTED") return { code: "CLOSED", reason };
      return { code: "PAUSED", reason };
    }
    case "BuysPaused": {
      const reason = bytes32Text(args[0]) || "PAUSED";
      return reason === "RESERVE_FLOOR" ? { code: "RESERVE_FLOOR", reason } : { code: "PAUSED", reason };
    }
    case "CapExceeded": return { code: "CAP_REACHED", reason: "CAP" };
    case "StressBudget": return { code: "CAP_REACHED", reason: "STRESS_BUDGET" };
    case "BelowMinimum": return { code: "BELOW_MIN", reason: "BELOW_MINIMUM" };
    case "InsufficientCash": return { code: "RESERVE_FLOOR", reason: "RESERVE_FLOOR" };
    // I9-3: the hook route is short of the input token (accepted risk L-7). Still UPSTREAM for a buy; the quote service
    // answers a sell from the direct minter path.
    case "PoolManagerShort": return { code: "UPSTREAM", reason: "PoolManagerShort" };
    case "UseQueue": return { code: "QUEUED", reason: "USE_QUEUE" };
    default: return { code: "UPSTREAM", reason: name };
  }
}

/** R3. A closed market pays a sell the lower of the last value and the reference (pool) value. */
export function closedSellValue(lastValueWad: bigint, refValueWad: bigint): bigint {
  return lastValueWad < refValueWad ? lastValueWad : refValueWad;
}

/** How a sell is paid: queued when the minter says so, `instant_min` when the market is not in a live session, else instant. */
export function sellModeOf(raw: Pick<RawQuote, "queued" | "session">): SellMode {
  if (raw.queued) return "queued";
  const session = raw.session === null ? 0 : raw.session;
  return session === 0 ? "instant" : "instant_min";
}

export const SLIPPAGE_BPS = 50n;
/** Minimum acceptable output for a 50 bps slippage allowance. */
export const minOutSuggested = (amountOut: bigint, bps: bigint = SLIPPAGE_BPS): bigint => (amountOut * (10_000n - bps)) / 10_000n;

/** I8-2: how far under the last good value a queued sell's suggested minimum sits (5%). */
export const QUEUE_MARGIN_BPS = 500n;
/** Suggested minimum USDG (6 decimals) for a queued sell: the minter's own amount less slippage when it gives one (a sell
 * queued only because cash is short), else the tokens at the last good value per token less QUEUE_MARGIN_BPS (a closed
 * or halted market quotes amountOut 0). null when neither is known: the caller must then choose a minimum; 0 is never
 * suggested, because anyone may fill a ticket at the next live price. */
export function queuedMinOut(tokens: bigint, amountOut: bigint, lastValueWad: bigint | null): bigint | null {
  if (amountOut > 0n) return minOutSuggested(amountOut);
  if (lastValueWad === null || lastValueWad <= 0n) return null;
  const min = (tokens * lastValueWad * (10_000n - QUEUE_MARGIN_BPS)) / 10_000n / 10n ** 30n;
  return min > 0n ? min : null;
}

/** Toll in bps per day as a decimal string (WAD fraction per day, times 1e4). Negative = holders receive. */
export const tollBpsText = (tollPerDayWad: bigint): string => formatUnits(tollPerDayWad, 14);

/** Days of toll that equal the spread. null when the toll is not positive (Eco and any negative toll: holders receive). */
export function breakevenDays(spreadBps: number, tollPerDayWad: bigint): number | null {
  if (tollPerDayWad <= 0n) return null;
  const tollBps = Number(tollPerDayWad) / 1e14;
  return Math.round((spreadBps / tollBps) * 100) / 100;
}
