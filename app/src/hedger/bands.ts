// R4, R5, R8: when to re-hedge. Pure. All amounts raw USDG (6 dp) bigint.
import { fromBps } from "../lib/fixed";

export type HoldReason =
  | "within_band" | "below_min_size" | "cooldown" | "stale_inputs" | "no_equity" | "disagree_with_chain" | "halted" | "no_venue" | "dry_run";
export type TradeReason = "band" | "hard_band" | "interval";

export interface RehedgeInput {
  /** target position minus current position (signed, raw USDG) */
  residualUsd: bigint;
  equityUsd: bigint;
  /** R8: Governor exposure and marks within HEDGER_MAX_INPUT_AGE_SECONDS */
  inputsFresh: boolean;
  /** R3: the indexed book disagrees with the chain (or the getter could not be read) */
  disagree: boolean;
  halted: boolean;
  nowMs: number;
  lastTradeMs?: number | undefined;
  bandBps: number;
  hardBandBps: number;
  intervalSeconds: number;
  cooldownSeconds: number;
  minTradeUsd: bigint;
}

export type RehedgeDecision = { trade: true; deltaUsd: bigint; reason: TradeReason } | { trade: false; reason: HoldReason };

const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * Trade when |residual| exceeds the band, at once beyond the hard band (which skips only the interval, never the cooldown),
 * at the interval if any residual above the minimum remains; never below the minimum, never inside the cooldown, never on
 * stale or disputed inputs or zero equity. A trade moves the residual to zero, not to the band edge.
 */
export function decideRehedge(i: RehedgeInput): RehedgeDecision {
  if (i.halted) return { trade: false, reason: "halted" };
  if (!i.inputsFresh) return { trade: false, reason: "stale_inputs" };
  if (i.disagree) return { trade: false, reason: "disagree_with_chain" };
  if (i.equityUsd <= 0n) return { trade: false, reason: "no_equity" };
  const size = abs(i.residualUsd);
  if (size === 0n || size < i.minTradeUsd) return { trade: false, reason: "below_min_size" };
  if (i.lastTradeMs !== undefined && i.nowMs - i.lastTradeMs < i.cooldownSeconds * 1000) return { trade: false, reason: "cooldown" };
  if (size > fromBps(i.equityUsd, i.hardBandBps)) return { trade: true, deltaUsd: i.residualUsd, reason: "hard_band" };
  if (size > fromBps(i.equityUsd, i.bandBps)) return { trade: true, deltaUsd: i.residualUsd, reason: "band" };
  if (i.lastTradeMs === undefined || i.nowMs - i.lastTradeMs >= i.intervalSeconds * 1000) {
    return { trade: true, deltaUsd: i.residualUsd, reason: "interval" };
  }
  return { trade: false, reason: "within_band" };
}

/** R5: 1% move P&L of the gamma book, 0.5 x G x 0.01^2 (raw USDG, rounded toward zero). */
export const gammaPnl1pctUsd = (gammaUsd: bigint): bigint => gammaUsd / 20_000n;

export interface GammaCheck { pnl1pctUsd: bigint; budgetUsd: bigint; over: boolean; bandBps: number; hardBandBps: number }

/** R5: above the budget (bps of equity per 1% move) the band tightens to half. Convexity itself is never traded. */
export function gammaBudget(gammaUsd: bigint, equityUsd: bigint, budgetBps: number, bandBps: number, hardBandBps: number): GammaCheck {
  const pnl = gammaPnl1pctUsd(gammaUsd);
  const budget = fromBps(equityUsd > 0n ? equityUsd : 0n, budgetBps);
  const over = abs(pnl) > budget;
  return { pnl1pctUsd: pnl, budgetUsd: budget, over, bandBps: over ? bandBps / 2 : bandBps, hardBandBps };
}

/** R8: exposure and marks within the max input age, and a non-zero equity. */
export function inputsFresh(ages: { exposureAgeMs: number; markAgeMs: number }, maxInputAgeSeconds: number): boolean {
  const max = maxInputAgeSeconds * 1000;
  return ages.exposureAgeMs >= 0 && ages.exposureAgeMs <= max && ages.markAgeMs >= 0 && ages.markAgeMs <= max;
}
