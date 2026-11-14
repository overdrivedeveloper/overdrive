import type { Sql } from "postgres";
export const latestReserve = async (sql: Sql) => (await sql<{ ts: Date; block: string; balance: string; floor: string; ringFenced: boolean }[]>`
  SELECT ts, block::text AS block, balance::text AS balance, "floor"::text AS "floor", ring_fenced AS "ringFenced" FROM exit_reserve_log ORDER BY block DESC, log_index DESC, ts DESC LIMIT 1`)[0];
export const queueStats = async (sql: Sql) => (await sql<{ depth: string; oldest: Date | null }[]>`
  SELECT COUNT(*)::text AS depth, MIN(queued_at) AS oldest FROM queued_sells WHERE status = 'open'`)[0]!;
export const queuedForAccount = (sql: Sql, account: string) => sql<{ ticket: string; gear: string; tokens: string; minProceeds: string; queuedAt: Date }[]>`
  SELECT ticket::text AS ticket, gear, tokens::text AS tokens, min_proceeds::text AS "minProceeds", queued_at AS "queuedAt"
  FROM queued_sells WHERE account = ${account.toLowerCase()} AND status = 'open' ORDER BY queued_at`;
