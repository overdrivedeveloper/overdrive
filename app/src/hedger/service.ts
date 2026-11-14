// One hedge cycle: per underlying, read the Governor's exposure on chain (the target) and cross-check it against the
// indexed ledger, net against every venue's position, apply the bands, and trade the residual to zero through the ordered
// venues. Never throws for one name: a failure is recorded, kept in `unhedged`, and the pass continues.
import type { Logger } from "pino";
import type { HedgerStore } from "../db/queries/hedges";
import { safeErrorSummary } from "../log";
import { fromBps } from "../lib/fixed";
import { decideRehedge, gammaBudget, inputsFresh, type HoldReason, type TradeReason } from "./bands";
import { agrees, exposureUsd, type ChainExposureReader, type IndexedReader } from "./exposure";
import type { HedgeMarket } from "./markets";
import { cycleBucket, HALT_MS, hedgeClientId, isTimeout, refusalOf } from "./policy";
import type { HedgerState } from "./state";
import type { HedgerSettings, IHedgeVenue, VenueFill } from "./types";

export interface CycleDeps {
  markets: readonly HedgeMarket[];
  chain: ChainExposureReader;
  indexed: IndexedReader;
  /** Age of the underlying's on-chain price (oracle mark) in ms; throws or Infinity when unknown. */
  markAgeMs(m: HedgeMarket): Promise<number>;
  venues: readonly IHedgeVenue[];
  /** Ordered route for a name (routes.ts); default: the configured venue order. */
  routeFor?(m: HedgeMarket, venues: readonly IHedgeVenue[]): readonly IHedgeVenue[];
  /** R13: asks the Governor for margin (sendToHedger) and deposits it on a fundable venue. Never called in dry run. */
  requestMargin?(venue: IHedgeVenue, usd: bigint): Promise<void>;
  store: HedgerStore;
  settings: HedgerSettings;
  state: HedgerState;
  now(): number;
  logger: Logger;
}

export type NameAction = "traded" | "would_trade" | "hold" | "failed";
export type NameReason = TradeReason | HoldReason | "trade_failed" | "partial";

export interface NameReport {
  underlying: string;
  deltaUsd: bigint;
  gammaUsd: bigint;
  positionUsd: bigint;
  residualUsd: bigint;
  /** residual left after this cycle's fills */
  unhedgedUsd: bigint;
  bandUsd: bigint;
  action: NameAction;
  reason: NameReason;
  hedged: boolean;
  fills: { venue: string; usd: bigint; clientId: string }[];
  gamma?: { pnl1pctUsd: bigint; budgetUsd: bigint; over: boolean };
  proxy?: boolean;
  error?: string;
}

export interface CycleResult {
  cycleAt: string;
  dryRun: boolean;
  names: Record<string, NameReport>;
  venueHealthy: boolean;
  venueUnhealthySince: string | null;
  unhealthyVenues: Record<string, string>;
  /** name -> since (ISO) and USD left unhedged; the crank risk monitor reads this from service_status.meta */
  unhedged: Record<string, { since: string; usd: string; reason: string; error?: string }>;
  gamma: Record<string, { pnl1pctUsd: string; budgetUsd: string; over: boolean }>;
  halted?: { reason: string; until: string };
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const minB = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const VENUE_DOWN_SIGNAL_MS = 15 * 60_000;
const UNHEDGED_SIGNAL_MS = 15 * 60_000;
/** Reasons that leave a name unhedged (reported, never hidden). Within-band and below-minimum holds are hedged. */
const UNHEDGED_REASONS = new Set<NameReason>(["no_venue", "trade_failed", "partial", "stale_inputs", "disagree_with_chain", "halted", "no_equity"]);

export async function runHedgeCycle(deps: CycleDeps): Promise<CycleResult> {
  const { settings, state, logger, store } = deps;
  const nowMs = deps.now();
  const at = new Date(nowMs);
  const bucket = cycleBucket(nowMs, settings.cycleSeconds);

  // Venue health first, so a down venue is visible even if the rest of the pass fails.
  const health = new Map<string, boolean>();
  for (const venue of deps.venues) {
    const h = await venue.healthy().catch((error) => ({ ok: false, reason: safeErrorSummary(error).message }));
    health.set(venue.name, h.ok);
    if (h.ok) {
      if (state.unhealthySince.delete(venue.name)) await store.clearSignal("venue_down", venue.name).catch(() => undefined);
    } else {
      if (!state.unhealthySince.has(venue.name)) state.unhealthySince.set(venue.name, nowMs);
      if (nowMs - state.unhealthySince.get(venue.name)! >= VENUE_DOWN_SIGNAL_MS) {
        await store.raiseSignal("venue_down", venue.name, { since: new Date(state.unhealthySince.get(venue.name)!).toISOString(), reason: h.reason ?? "" }).catch(() => undefined);
      }
    }
  }
  if (state.haltedUntilMs !== undefined && state.haltedUntilMs <= nowMs) {
    logger.info({ reason: state.haltReason }, "Hedger halt over; trades are tried again");
    delete state.haltedUntilMs;
    delete state.haltReason;
  }

  let head: { block: bigint; timestampMs: number } | undefined;
  try { head = await deps.chain.head(); } catch (error) { logger.warn({ err: safeErrorSummary(error) }, "Chain head unreadable; every name holds"); }

  const names: Record<string, NameReport> = {};
  for (const m of deps.markets) {
    const report: NameReport = {
      underlying: m.symbol, deltaUsd: 0n, gammaUsd: 0n, positionUsd: 0n, residualUsd: 0n, unhedgedUsd: 0n, bandUsd: 0n,
      action: "hold", reason: "stale_inputs", hedged: false, fills: [],
    };
    names[m.symbol] = report;
    let inputAgeS: number | null = null;
    try {
      await hedgeOne(deps, m, report, head, nowMs, bucket, health, (s) => { inputAgeS = s; });
    } catch (error) {
      report.action = "failed";
      report.reason = "trade_failed";
      report.hedged = false;
      report.error = safeErrorSummary(error).message;
      const refusal = refusalOf(error);
      if (refusal) {
        state.haltedUntilMs = nowMs + HALT_MS;
        state.haltReason = refusal;
        logger.error({ alert: true, underlying: m.symbol, refusal }, "ALERT: a hedge was refused; trading halts for an hour");
      } else {
        logger.warn({ underlying: m.symbol, err: safeErrorSummary(error) }, "Hedge failed for this name; the pass continues");
      }
    }
    await store.recordCycle({
      ts: at, underlying: m.symbol, deltaUsd: report.deltaUsd, gammaUsd: report.gammaUsd, positionUsd: report.positionUsd,
      residualUsd: report.residualUsd, bandUsd: report.bandUsd, action: report.action, reason: report.reason, inputAgeS,
    }).catch((error) => logger.warn({ err: safeErrorSummary(error), underlying: m.symbol }, "Could not record the hedge cycle row"));
  }

  // R7: what could not be hedged stays visible with a since time.
  for (const [symbol, r] of Object.entries(names)) {
    const open = UNHEDGED_REASONS.has(r.reason) && (abs(r.unhedgedUsd) >= settings.minTradeUsd || r.reason === "trade_failed" || r.reason === "no_venue");
    if (open) {
      const prev = state.unhedged.get(symbol);
      state.unhedged.set(symbol, { sinceMs: prev?.sinceMs ?? nowMs, usd: r.unhedgedUsd, reason: r.reason, ...(r.error ? { error: r.error } : {}) });
      if (nowMs - (prev?.sinceMs ?? nowMs) >= UNHEDGED_SIGNAL_MS) {
        await store.raiseSignal("unhedged", symbol, { since: new Date(prev!.sinceMs).toISOString(), usd: r.unhedgedUsd.toString(), reason: r.reason }).catch(() => undefined);
      }
    } else if (state.unhedged.delete(symbol)) {
      await store.clearSignal("unhedged", symbol).catch(() => undefined);
    }
  }
  for (const symbol of [...state.unhedged.keys()]) if (!(symbol in names)) state.unhedged.delete(symbol);

  const unhealthy = [...state.unhealthySince];
  const result: CycleResult = {
    cycleAt: at.toISOString(),
    dryRun: settings.dryRun,
    names,
    venueHealthy: unhealthy.length === 0,
    venueUnhealthySince: unhealthy.length ? new Date(Math.min(...unhealthy.map(([, t]) => t))).toISOString() : null,
    unhealthyVenues: Object.fromEntries(unhealthy.map(([n, t]) => [n, new Date(t).toISOString()])),
    unhedged: Object.fromEntries([...state.unhedged].map(([s, u]) => [s, { since: new Date(u.sinceMs).toISOString(), usd: u.usd.toString(), reason: u.reason, ...(u.error ? { error: u.error } : {}) }])),
    gamma: Object.fromEntries(Object.values(names).filter((r) => r.gamma).map((r) => [r.underlying, { pnl1pctUsd: r.gamma!.pnl1pctUsd.toString(), budgetUsd: r.gamma!.budgetUsd.toString(), over: r.gamma!.over }])),
    ...(state.haltedUntilMs !== undefined ? { halted: { reason: state.haltReason ?? "halted", until: new Date(state.haltedUntilMs).toISOString() } } : {}),
  };
  await store.writeStatus("hedger", true, {
    cycleAt: result.cycleAt, dryRun: result.dryRun, venueHealthy: result.venueHealthy, venueUnhealthySince: result.venueUnhealthySince,
    unhealthyVenues: result.unhealthyVenues, unhedged: result.unhedged, gamma: result.gamma, halted: result.halted ?? null,
  }).catch((error) => logger.warn({ err: safeErrorSummary(error) }, "Could not write hedger status"));
  if (Object.keys(result.unhedged).length) logger.warn({ unhedged: result.unhedged }, "Names left unhedged this cycle");
  return result;
}

async function hedgeOne(
  deps: CycleDeps, m: HedgeMarket, report: NameReport, head: { block: bigint; timestampMs: number } | undefined,
  nowMs: number, bucket: number, health: ReadonlyMap<string, boolean>, setAge: (s: number) => void,
): Promise<void> {
  const { settings, state, store, logger } = deps;
  const hold = (reason: HoldReason) => { report.action = "hold"; report.reason = reason; report.hedged = false; report.unhedgedUsd = report.residualUsd; };
  if (!head) return hold("stale_inputs");

  // R3: the chain is the target; an unreadable getter holds (fail closed).
  let chain;
  try { chain = await deps.chain.exposure(m.market, m.symbol, head.block); } catch (error) {
    logger.warn({ underlying: m.symbol, err: safeErrorSummary(error) }, "Governor exposure unreadable; holding");
    await store.raiseSignal("stale_inputs", m.symbol, { unreadable: true }).catch(() => undefined);
    return hold("stale_inputs");
  }
  const { deltaUsd, gammaUsd, equityUsd } = exposureUsd(chain);
  report.deltaUsd = deltaUsd;
  report.gammaUsd = gammaUsd;

  // Every venue's position, healthy or not (an unhealthy venue still holds its hedge). An unreadable position holds.
  let position = 0n;
  const venuePos = new Map<string, bigint>();
  for (const v of deps.venues) {
    const p = await v.netPositionUsd(m.symbol);
    venuePos.set(v.name, p);
    position += p;
  }
  report.positionUsd = position;
  report.residualUsd = deltaUsd - position;
  report.unhedgedUsd = report.residualUsd;

  // R5: gamma is measured and budgeted, never traded.
  const g = gammaBudget(gammaUsd, equityUsd, settings.gammaBudgetBps, settings.bandBps, settings.hardBandBps);
  report.gamma = { pnl1pctUsd: g.pnl1pctUsd, budgetUsd: g.budgetUsd, over: g.over };
  if (g.over) await store.raiseSignal("gamma_over_budget", m.symbol, { pnl1pctUsd: g.pnl1pctUsd.toString(), budgetUsd: g.budgetUsd.toString() }).catch(() => undefined);
  else await store.clearSignal("gamma_over_budget", m.symbol).catch(() => undefined);
  report.bandUsd = fromBps(equityUsd > 0n ? equityUsd : 0n, g.bandBps);

  // R8: ages. R3: indexed cross-check at or before the same block.
  const exposureAgeMs = nowMs - head.timestampMs;
  const markAgeMs = await deps.markAgeMs(m).catch(() => Number.POSITIVE_INFINITY);
  setAge(Math.round(Math.max(exposureAgeMs, Number.isFinite(markAgeMs) ? markAgeMs : 0) / 1000));
  const indexed = await deps.indexed.latest(m.symbol, head.block).catch(() => null);
  const indexedFresh = indexed !== null && nowMs - indexed.ts.getTime() <= settings.maxInputAgeSeconds * 1000;
  const fresh = inputsFresh({ exposureAgeMs, markAgeMs }, settings.maxInputAgeSeconds) && indexedFresh;
  const disagree = indexed !== null && !agrees(deltaUsd, indexed.deltaUsd, equityUsd, settings.disagreeBps, settings.disagreeFloorUsd);
  if (fresh && disagree) {
    await store.raiseSignal("disagree_with_chain", m.symbol, { chainDeltaUsd: deltaUsd.toString(), indexedDeltaUsd: indexed!.deltaUsd.toString(), block: head.block.toString(), indexedBlock: indexed!.block.toString() }).catch(() => undefined);
    logger.warn({ underlying: m.symbol }, "Indexed book disagrees with the chain; holding");
  } else if (fresh) {
    await store.clearSignal("disagree_with_chain", m.symbol).catch(() => undefined);
  }
  if (!fresh) logger.warn({ underlying: m.symbol, exposureAgeMs, markAgeMs, indexedFresh }, "Hedger inputs stale; holding");

  const decision = decideRehedge({
    residualUsd: report.residualUsd, equityUsd, inputsFresh: fresh, disagree, halted: state.haltedUntilMs !== undefined,
    nowMs, lastTradeMs: state.lastTradeMs.get(m.symbol), bandBps: g.bandBps, hardBandBps: g.hardBandBps,
    intervalSeconds: settings.intervalSeconds, cooldownSeconds: settings.cooldownSeconds, minTradeUsd: settings.minTradeUsd,
  });
  if (!decision.trade) {
    hold(decision.reason);
    // within band or below the minimum: hedged as far as the policy asks
    if (decision.reason === "within_band" || decision.reason === "below_min_size" || decision.reason === "cooldown") report.hedged = true;
    return;
  }

  // Route: ordered venues; healthy, market open now (R9), fresh venue mark; split by depth share and margin room.
  const route = (deps.routeFor ? deps.routeFor(m, deps.venues) : deps.venues).filter((v) => health.get(v.name) === true && v.canTrade(m.symbol));
  const buy = decision.deltaUsd > 0n;
  let remaining = decision.deltaUsd;
  let leg = 0;
  let filledTotal = 0n;
  let failed: unknown;
  for (const venue of route) {
    if (remaining === 0n || (buy ? remaining < 0n : remaining > 0n)) break;
    leg++;
    const mark = await venue.markPrice(m.symbol).catch(() => null);
    if (!mark || mark.px <= 0n || mark.ageMs > settings.venueMarkMaxAgeMs) continue;
    const depth = await venue.maxTradeUsd(m.symbol, buy ? "buy" : "sell").catch(() => 0n);
    let size = minB(abs(remaining), fromBps(depth, settings.maxBookShareBps));
    const current = venuePos.get(venue.name) ?? 0n;
    // Margin room only matters for the part that grows |position| on this venue.
    const grows = buy ? current >= 0n : current <= 0n;
    if (grows || size > abs(current)) {
      const room = await marginRoom(deps, venue, current, size, buy);
      size = minB(size, room);
    }
    // Proxy basis: cap the hedged share of an index proxy.
    if (venue.basis(m.symbol).proxy) {
      report.proxy = true;
      await store.raiseSignal("proxy_basis", m.symbol, { venue: venue.name, note: venue.basis(m.symbol).note ?? "" }).catch(() => undefined);
      const cap = fromBps(equityUsd, settings.proxyMaxBps);
      size = minB(size, grows ? (cap > abs(current) ? cap - abs(current) : 0n) : abs(current) + cap);
    }
    if (size <= 0n || size < settings.minTradeUsd) continue;
    const signed = buy ? size : -size;
    const clientId = hedgeClientId(m.symbol, bucket, deltaUsd, venue.name, leg);

    if (settings.dryRun) {
      await store.recordHedge({ ts: new Date(nowMs), venue: venue.name, underlying: m.symbol, usd: signed, px: mark.px, feesUsd: 0n, ref: null, reason: decision.reason, dry: true, clientId });
      report.fills.push({ venue: venue.name, usd: signed, clientId });
      remaining -= signed;
      filledTotal += signed;
      continue;
    }
    try {
      const fill = await sendOnce(deps, venue, m.symbol, signed, clientId);
      if (fill) {
        await store.recordHedge({ ts: new Date(nowMs), venue: venue.name, underlying: m.symbol, usd: fill.filledUsd, px: fill.avgPx, feesUsd: fill.feesUsd, ref: fill.ref || null, reason: decision.reason, dry: false, clientId });
        report.fills.push({ venue: venue.name, usd: fill.filledUsd, clientId });
        remaining -= fill.filledUsd;
        filledTotal += fill.filledUsd;
      }
    } catch (error) {
      if (refusalOf(error)) throw error;
      failed = error;
      logger.warn({ underlying: m.symbol, venue: venue.name, err: safeErrorSummary(error) }, "Venue trade failed; trying the next route");
    }
  }

  report.unhedgedUsd = report.residualUsd - filledTotal;
  if (filledTotal !== 0n) {
    if (!settings.dryRun) state.lastTradeMs.set(m.symbol, nowMs);
    report.action = settings.dryRun ? "would_trade" : "traded";
    report.reason = settings.dryRun ? "dry_run" : abs(report.unhedgedUsd) >= settings.minTradeUsd ? "partial" : decision.reason;
    report.hedged = abs(report.unhedgedUsd) < settings.minTradeUsd;
    return;
  }
  report.action = failed ? "failed" : "hold";
  report.reason = failed ? "trade_failed" : "no_venue";
  report.hedged = false;
  if (failed) report.error = safeErrorSummary(failed).message;
}

/**
 * R10: before sending, the store and the venue are asked whether this client id already filled; after a timeout the venue
 * is asked again before one retry. A crash between send and record therefore never sends a second order.
 */
async function sendOnce(deps: CycleDeps, venue: IHedgeVenue, underlying: string, deltaUsd: bigint, clientId: string): Promise<VenueFill | null> {
  if (await deps.store.hedgeByClientId(clientId)) return null;
  const known = await venue.fillByClientId(underlying, clientId);
  if (known) return known;
  const opts = { maxSlippageBps: deps.settings.maxSlippageBps, clientId };
  try {
    return await venue.trade(underlying, deltaUsd, opts);
  } catch (error) {
    if (!isTimeout(error)) throw error;
    const after = await venue.fillByClientId(underlying, clientId);
    if (after) return after;
    return await venue.trade(underlying, deltaUsd, opts);
  }
}

/**
 * How much more notional this venue may hold in the trade direction: its margin (topped up when fundable and allowed,
 * R13) times leverage, minus what the current position already uses, and never past HEDGER_MAX_VENUE_MARGIN_USDG.
 */
async function marginRoom(deps: CycleDeps, venue: IHedgeVenue, current: bigint, size: bigint, buy: boolean): Promise<bigint> {
  const { settings } = deps;
  const im = BigInt(settings.initialMarginBps);
  const grows = buy ? current >= 0n : current <= 0n;
  const after = abs(current + (buy ? size : -size));
  const needed = (after * im + 9_999n) / 10_000n;
  const cap = settings.maxVenueMarginUsd;
  let margin = await venue.marginEquityUsd();
  if (needed > margin && venue.fundable && cap > margin) {
    const topUp = minB(needed - margin, cap - margin);
    if (settings.dryRun) margin += topUp; // a dry run assumes the top-up it would have asked for, and asks nothing
    else if (deps.requestMargin) {
      await deps.requestMargin(venue, topUp);
      margin = await venue.marginEquityUsd();
    }
  }
  const usable = cap > 0n ? minB(margin, cap) : margin;
  const maxPos = usable > 0n ? (usable * 10_000n) / im : 0n;
  const room = grows ? (maxPos > abs(current) ? maxPos - abs(current) : 0n) : abs(current) + maxPos;
  return minB(size, room);
}
