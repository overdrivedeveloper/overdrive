// R17: hedge posting is a safety duty. After every cycle, and at least every hedgeMaxAge / 2 even when nothing traded,
// the hedger calls IODGovernor.postHedge(market, hedgeDeltaWad, hedgeEquityUsdg, asOf) for each hedged market: a post
// older than hedgeMaxAge pauses buys on chain and a stale hedge counts as zero in the stress budget.
// Fail closed: an unhealthy venue or a read error posts nothing for that market and raises hedge_post_missed with the
// time left before the chain pauses buys. A contract refusal halts posting for an hour and alerts.
import type { Logger } from "pino";
import { revertNameOf } from "../../chain/revert";
import type { HedgerStore } from "../../db/queries/hedges";
import { safeErrorSummary } from "../../log";
import { fromBps, usdgToWad } from "../../lib/fixed";
import type { HedgeMarket } from "../markets";
import { HALT_MS, refusalOf } from "../policy";
import type { Hex, IHedgeVenue } from "../types";

export interface GovernorHedgeConfig { hedgeMaxAgeS: number; maxHedgeJumpBps: number }

export interface PostState {
  last: Map<string, { asOf: number; atMs: number; equityUsd: bigint }>;
  haltedUntilMs?: number;
  haltReason?: string;
}
export const newPostState = (): PostState => ({ last: new Map() });

export interface PostDeps {
  markets: readonly HedgeMarket[];
  venues: readonly IHedgeVenue[];
  store: HedgerStore;
  logger: Logger;
  now(): number;
  dryRun: boolean;
  state: PostState;
  /** latest block timestamp, seconds */
  chainTimeS(): Promise<number>;
  governorConfig(): Promise<GovernorHedgeConfig>;
  postHedge(market: Hex, hedgeDeltaWad: bigint, hedgeEquityUsdg: bigint, asOf: bigint): Promise<void>;
}

export type PostAction = "posted" | "would_post" | "not_due" | "missed" | "halted";
export interface PostReport { action: PostAction; reason?: string; hedgeDeltaUsd?: bigint; equityUsd?: bigint; timeLeftS?: number }

const abs = (x: bigint) => (x < 0n ? -x : x);

/** `traded`: names that traded in the cycle just run (always posted). */
export async function runHedgePosts(deps: PostDeps, traded: ReadonlySet<string> = new Set()): Promise<Record<string, PostReport>> {
  const { state, store, logger } = deps;
  const nowMs = deps.now();
  const out: Record<string, PostReport> = {};
  const timeLeft = (symbol: string, maxAgeS: number) => {
    const last = state.last.get(symbol);
    return last ? Math.floor((last.atMs + maxAgeS * 1000 - nowMs) / 1000) : 0;
  };
  const missed = async (symbol: string, reason: string, maxAgeS: number) => {
    const left = timeLeft(symbol, maxAgeS);
    out[symbol] = { action: "missed", reason, timeLeftS: left };
    logger.error({ alert: true, underlying: symbol, reason, timeLeftS: left }, "ALERT: hedge post missed; buys pause on chain when the last post ages out");
    await store.raiseSignal("hedge_post_missed", symbol, { reason, timeLeftS: left }).catch(() => undefined);
  };

  let config: GovernorHedgeConfig;
  let chainTimeS: number;
  try {
    [config, chainTimeS] = await Promise.all([deps.governorConfig(), deps.chainTimeS()]);
  } catch (error) {
    for (const m of deps.markets) if (state.last.has(m.symbol)) await missed(m.symbol, `governor unreadable: ${safeErrorSummary(error).message}`, 0);
    return out;
  }
  if (state.haltedUntilMs !== undefined) {
    if (state.haltedUntilMs > nowMs) {
      for (const m of deps.markets) {
        out[m.symbol] = { action: "halted", reason: state.haltReason ?? "refused", timeLeftS: timeLeft(m.symbol, config.hedgeMaxAgeS) };
      }
      logger.error({ alert: true, reason: state.haltReason, until: new Date(state.haltedUntilMs).toISOString() }, "ALERT: hedge posting halted after a refusal");
      return out;
    }
    delete state.haltedUntilMs;
    delete state.haltReason;
  }

  // One health and position read per venue and market, before any post (fail closed per market).
  const health = new Map<string, boolean>();
  for (const v of deps.venues) health.set(v.name, (await v.healthy().catch(() => ({ ok: false }))).ok);
  const pos = new Map<string, Map<string, bigint>>(); // symbol -> venue -> usd
  const readErr = new Map<string, string>();
  for (const m of deps.markets) {
    const row = new Map<string, bigint>();
    for (const v of deps.venues) {
      try { row.set(v.name, await v.netPositionUsd(m.symbol)); } catch (error) { readErr.set(m.symbol, `${v.name}: ${safeErrorSummary(error).message}`); }
    }
    pos.set(m.symbol, row);
  }
  // Venue equity (only venues whose equity is not already on chain) is split across markets by |notional| on that venue.
  const venueEquity = new Map<string, bigint>();
  for (const v of deps.venues) {
    if (!v.postsEquity || !health.get(v.name)) continue;
    try { venueEquity.set(v.name, await v.marginEquityUsd()); } catch { /* reported per market below */ }
  }

  for (const m of deps.markets) {
    const row = pos.get(m.symbol)!;
    const hedgeUsd = [...row.values()].reduce((a, b) => a + b, 0n);
    const previously = state.last.get(m.symbol);
    if (hedgeUsd === 0n && !previously && !readErr.has(m.symbol)) { out[m.symbol] = { action: "not_due", reason: "no hedge" }; continue; }
    const involved = deps.venues.filter((v) => (row.get(v.name) ?? 0n) !== 0n);
    const down = involved.find((v) => !health.get(v.name));
    if (readErr.has(m.symbol)) { await missed(m.symbol, `position unreadable (${readErr.get(m.symbol)})`, config.hedgeMaxAgeS); continue; }
    if (down) { await missed(m.symbol, `venue ${down.name} unhealthy`, config.hedgeMaxAgeS); continue; }
    let equity = 0n;
    let equityMissing = false;
    for (const v of involved) {
      if (!v.postsEquity) continue;
      const total = venueEquity.get(v.name);
      if (total === undefined) { equityMissing = true; break; }
      let all = 0n;
      for (const other of pos.values()) all += abs(other.get(v.name) ?? 0n);
      equity += all === 0n ? 0n : (total * abs(row.get(v.name)!)) / all;
    }
    if (equityMissing) { await missed(m.symbol, "venue equity unreadable", config.hedgeMaxAgeS); continue; }

    const due = traded.has(m.symbol) || !previously || nowMs - previously.atMs >= (config.hedgeMaxAgeS * 1000) / 2;
    if (!due) { out[m.symbol] = { action: "not_due", hedgeDeltaUsd: hedgeUsd, equityUsd: equity }; continue; }
    const asOf = Math.min(chainTimeS, Math.floor(nowMs / 1000));
    if (previously && asOf < previously.asOf) { await missed(m.symbol, "chain time is behind the previous post", config.hedgeMaxAgeS); continue; }
    if (previously && previously.equityUsd > 0n) {
      const bound = fromBps(previously.equityUsd, config.maxHedgeJumpBps);
      if (equity > previously.equityUsd + bound) equity = previously.equityUsd + bound; // understating a rise is safe
      else if (equity < previously.equityUsd - bound) { await missed(m.symbol, "equity fell past maxHedgeJumpBps; the contract would refuse", config.hedgeMaxAgeS); continue; }
    }
    if (deps.dryRun) { out[m.symbol] = { action: "would_post", hedgeDeltaUsd: hedgeUsd, equityUsd: equity }; continue; }
    try {
      await deps.postHedge(m.market, usdgToWad(hedgeUsd), equity, BigInt(asOf));
      state.last.set(m.symbol, { asOf, atMs: nowMs, equityUsd: equity });
      await store.clearSignal("hedge_post_missed", m.symbol).catch(() => undefined);
      out[m.symbol] = { action: "posted", hedgeDeltaUsd: hedgeUsd, equityUsd: equity };
    } catch (error) {
      const refusal = refusalOf(error) ?? revertNameOf(error);
      if (refusal) {
        state.haltedUntilMs = nowMs + HALT_MS;
        state.haltReason = refusal;
        await missed(m.symbol, `refused: ${refusal}; posting halted for an hour`, config.hedgeMaxAgeS);
        out[m.symbol]!.action = "halted";
        break;
      }
      await missed(m.symbol, `post failed: ${safeErrorSummary(error).message}`, config.hedgeMaxAgeS);
    }
  }
  return out;
}
