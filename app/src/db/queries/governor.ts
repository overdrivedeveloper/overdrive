import type { Sql } from "postgres";

export interface LedgerRow { ts: Date; underlying: string; delta: string; gamma: string; hedgeDelta: string; equity: string; exitReserve: string; block: string }
/** Latest ledger row per underlying. */
export const latestLedger = (sql: Sql) => sql<LedgerRow[]>`
  SELECT DISTINCT ON (underlying) ts, underlying, delta::text AS delta, gamma::text AS gamma, hedge_delta::text AS "hedgeDelta",
    equity::text AS equity, exit_reserve::text AS "exitReserve", block::text AS block
  FROM governor_ledger ORDER BY underlying, ts DESC`;
export const ledgerSince = (sql: Sql, since: Date, limit: number) => sql<LedgerRow[]>`
  SELECT ts, underlying, delta::text AS delta, gamma::text AS gamma, hedge_delta::text AS "hedgeDelta", equity::text AS equity,
    exit_reserve::text AS "exitReserve", block::text AS block
  FROM governor_ledger WHERE ts >= ${since.toISOString()} ORDER BY ts DESC, underlying LIMIT ${limit}`;
/** The time since which an underlying has carried a hedge residual (delta not equal to hedge delta) without interruption. */
export const unhedgedSince = async (sql: Sql, underlying: string): Promise<Date | null> => {
  const rows = await sql<{ ts: Date; delta: string; hedge: string }[]>`
    SELECT ts, delta::text AS delta, hedge_delta::text AS hedge FROM governor_ledger WHERE underlying = ${underlying} ORDER BY ts DESC LIMIT 500`;
  let since: Date | null = null;
  for (const row of rows) {
    if (BigInt(row.delta) === BigInt(row.hedge)) break;
    since = row.ts;
  }
  return since;
};
export const latestStressRun = (sql: Sql) => sql<{ ts: Date; meta: Record<string, unknown> }[]>`
  SELECT COALESCE(last_ok, last_run) AS ts, meta FROM service_status WHERE job = 'risk-sim' LIMIT 1`;
