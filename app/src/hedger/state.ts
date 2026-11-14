// In-memory hedger state carried between cycles. Restart-safe by construction: positions are re-read from venues and
// fills are recorded with a unique client id, so losing this state never double hedges (it only resets timers).
export interface HedgerState {
  /** underlying -> epoch ms of the last trade (cooldown, interval) */
  lastTradeMs: Map<string, number>;
  /** venue name -> epoch ms since which it has been unhealthy */
  unhealthySince: Map<string, number>;
  /** underlying -> since when it could not be hedged, and how much is left */
  unhedged: Map<string, { sinceMs: number; usd: bigint; reason: string; error?: string }>;
  /** set after a refusal or by the operator: no trade is sent before this */
  haltedUntilMs?: number;
  haltReason?: string;
}

export const newHedgerState = (): HedgerState => ({ lastTradeMs: new Map(), unhealthySince: new Map(), unhedged: new Map() });
