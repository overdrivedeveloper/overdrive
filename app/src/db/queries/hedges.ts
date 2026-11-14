import type { Sql } from "postgres";
export const recentHedges = (sql: Sql, limit: number) => sql<{ ts: Date; underlying: string; delta: string; hedgeDelta: string; block: string }[]>`
  SELECT ts, underlying, delta::text AS delta, hedge_delta::text AS "hedgeDelta", block::text AS block FROM governor_ledger
  WHERE hedge_delta <> 0 ORDER BY ts DESC LIMIT ${limit}`;
export const hedgeFills = (sql: Sql, limit: number) => sql<{ ts: Date; meta: Record<string, unknown> }[]>`
  SELECT COALESCE(last_ok, last_run) AS ts, meta FROM service_status WHERE job = 'hedger' LIMIT 1`.then((rows) => rows.slice(0, limit));
