import type { Sql } from "postgres";

export interface Freshness {
  asOfBlock: string;
  asOf: string;
  stale: boolean;
  lagBlocks: string | null;
  snapshotStale: boolean;
  lastOk: string | null;
  lastError: string | null;
}
/** Indexer snapshot older than this is stale (Governor and exit pages never show a number as live past it). */
export const SNAPSHOT_STALE_MS = 30 * 60_000;

interface IndexerRow { last_ok: Date | null; last_error: string | null; meta: Record<string, unknown> | null }

export async function readFreshness(sql: Sql, now: Date): Promise<Freshness> {
  const [cursor] = await sql<{ block: string; updated_at: Date }[]>`SELECT block::text, updated_at FROM cursors WHERE name = 'main'`;
  const [indexer] = await sql<IndexerRow[]>`SELECT last_ok, last_error, meta FROM service_status WHERE job = 'indexer'`;
  const lastOk = indexer?.last_ok ?? null;
  const snapshotStale = indexer?.meta?.snapshotStale === true;
  const old = !lastOk || now.getTime() - lastOk.getTime() > SNAPSHOT_STALE_MS;
  const lag = indexer?.meta?.lag;
  return {
    asOfBlock: cursor?.block ?? "0",
    asOf: (lastOk ?? cursor?.updated_at ?? now).toISOString(),
    stale: old || snapshotStale,
    lagBlocks: lag === undefined || lag === null ? null : String(lag),
    snapshotStale,
    lastOk: lastOk ? lastOk.toISOString() : null,
    lastError: indexer?.last_error ?? null,
  };
}

export interface ServiceRow { job: string; lastRun: string | null; lastOk: string | null; lastError: string | null; meta: Record<string, unknown> }
export async function readServices(sql: Sql): Promise<ServiceRow[]> {
  const rows = await sql<{ job: string; last_run: Date | null; last_ok: Date | null; last_error: string | null; meta: Record<string, unknown> }[]>`
    SELECT job, last_run, last_ok, last_error, meta FROM service_status ORDER BY job`;
  return rows.map((r) => ({ job: r.job, lastRun: r.last_run?.toISOString() ?? null, lastOk: r.last_ok?.toISOString() ?? null, lastError: r.last_error, meta: r.meta ?? {} }));
}

export interface PauseRow { scope: string; ref: string | null; action: string; actor: string | null; reason: string | null; ts: string }
/** The latest action per (scope, ref): the ones whose latest action is a pause are in force. */
export async function readActivePauses(sql: Sql): Promise<PauseRow[]> {
  const rows = await sql<{ scope: string; ref: string | null; action: string; actor: string | null; reason: string | null; ts: Date }[]>`
    SELECT DISTINCT ON (scope, COALESCE(ref, '')) scope, ref, action, actor, reason, ts
    FROM pause_log ORDER BY scope, COALESCE(ref, ''), block DESC, log_index DESC`;
  return rows.filter((r) => r.action === "pause").map((r) => ({ ...r, ts: r.ts.toISOString() }));
}
