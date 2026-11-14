// Postgres job table: replaces Redis and BullMQ. One row per job, claimed with `for update skip locked` under a lease.
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";
import postgres, { type Sql } from "postgres";
import { safeErrorSummary } from "../log";

type Db = Pick<Sql, never> & Sql;

export interface Job {
  id: bigint;
  kind: string;
  dedupeKey: string;
  payload: unknown;
  runAt: Date;
  status: "queued" | "running" | "done" | "failed" | "dead";
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastError: string | null;
  result: unknown;
}

interface JobRow {
  id: string; kind: string; dedupe_key: string; payload: unknown; run_at: Date; status: Job["status"]; attempts: number;
  max_attempts: number; locked_by: string | null; locked_until: Date | null; last_error: string | null; result: unknown;
}

const toJob = (row: JobRow): Job => ({
  id: BigInt(row.id), kind: row.kind, dedupeKey: row.dedupe_key, payload: row.payload, runAt: row.run_at, status: row.status,
  attempts: row.attempts, maxAttempts: row.max_attempts, lockedBy: row.locked_by, lockedUntil: row.locked_until, lastError: row.last_error, result: row.result,
});

/** Delay in ms before attempt number `failures + 1`: 15 s, 30 s, 60 s ... doubling, capped at 10 minutes. */
export function jobBackoffMs(failures: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, Math.min(failures - 1, 6)), 600_000);
}

/** Inserts a job unless `(kind, dedupeKey)` already exists; then `created` is false and the existing id is returned. */
export async function enqueue(
  sql: Db,
  job: { kind: string; dedupeKey: string; payload?: unknown; runAt?: Date; maxAttempts?: number },
): Promise<{ id: bigint; created: boolean }> {
  const payload = JSON.stringify(job.payload ?? {});
  const inserted = await sql<{ id: string }[]>`
    insert into jobs (kind, dedupe_key, payload, run_at, max_attempts)
    values (${job.kind}, ${job.dedupeKey}, ${payload}::jsonb, ${(job.runAt ?? new Date()).toISOString()}::timestamptz, ${job.maxAttempts ?? 8})
    on conflict (kind, dedupe_key) do nothing returning id`;
  if (inserted[0]) return { id: BigInt(inserted[0].id), created: true };
  const existing = await sql<{ id: string }[]>`select id from jobs where kind = ${job.kind} and dedupe_key = ${job.dedupeKey}`;
  return { id: BigInt(existing[0]!.id), created: false };
}

/** Claims up to `limit` due jobs of `kinds` (queued and due, or running with an expired lease). Never returns a job to two workers. */
export async function claim(sql: Db, worker: string, kinds: readonly string[], lease: { seconds: number }, limit = 1): Promise<Job[]> {
  if (kinds.length === 0) return [];
  const rows = await sql<JobRow[]>`
    update jobs set status = 'running', locked_by = ${worker}, locked_until = now() + make_interval(secs => ${lease.seconds}), attempts = attempts + 1
    where id in (
      select id from jobs
      where kind in ${sql(kinds as string[])}
        and ((status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now()))
      order by run_at, id
      limit ${limit}
      for update skip locked)
    returning *`;
  return rows.map(toJob);
}

export async function complete(sql: Db, id: bigint, result?: unknown): Promise<void> {
  await sql`update jobs set status = 'done', result = ${JSON.stringify(result ?? null)}::jsonb, locked_by = null, locked_until = null, last_error = null where id = ${id.toString()}`;
}

/** Records a failure: back off 15 s doubling to 10 min, or mark the job `dead` (and raise a service_status error row) at max_attempts. */
export async function fail(sql: Db, id: bigint, error: string): Promise<void> {
  const rows = await sql<{ kind: string; attempts: number; max_attempts: number }[]>`select kind, attempts, max_attempts from jobs where id = ${id.toString()}`;
  const row = rows[0];
  if (!row) return;
  const message = error.slice(0, 1000);
  if (row.attempts >= row.max_attempts) {
    await sql.begin(async (tx) => {
      await tx`update jobs set status = 'dead', last_error = ${message}, locked_by = null, locked_until = null where id = ${id.toString()}`;
      await tx`insert into service_status (job, last_run, last_error, meta) values (${`jobs:${row.kind}`}, now(), ${`dead job ${id}: ${message}`}, ${JSON.stringify({ deadJobId: id.toString() })}::jsonb)
        on conflict (job) do update set last_run = excluded.last_run, last_error = excluded.last_error, meta = service_status.meta || excluded.meta`;
    });
    return;
  }
  const delay = jobBackoffMs(row.attempts);
  await sql`update jobs set status = 'queued', last_error = ${message}, run_at = now() + make_interval(secs => ${delay / 1000}), locked_by = null, locked_until = null where id = ${id.toString()}`;
}

/** Moves job_schedule rows whose next_run_at passed into jobs (one job per due slot, deduped on the slot time) and advances them. */
export async function runDueSchedules(sql: Db, now: Date): Promise<string[]> {
  return sql.begin(async (tx) => {
    const due = await tx<{ name: string; every_ms: number; slot: string }[]>`
      select name, every_ms, next_run_at::text as slot from job_schedule where enabled and next_run_at <= ${now.toISOString()}::timestamptz order by next_run_at for update skip locked`;
    const names: string[] = [];
    for (const row of due) {
      await tx`insert into jobs (kind, dedupe_key, run_at) values (${row.name}, ${row.slot}, ${now.toISOString()}::timestamptz) on conflict (kind, dedupe_key) do nothing`;
      await tx`update job_schedule set next_run_at = ${new Date(now.getTime() + row.every_ms).toISOString()}::timestamptz where name = ${row.name}`;
      names.push(row.name);
    }
    return names;
  });
}

// --------------------------------------------------------------------------------------------------------- scheduler
export interface ServiceJob {
  name: string;
  everyMs: number;
  jitterMs?: number;
  initialDelayMs?: number;
  run: () => Promise<Record<string, unknown> | void>;
}

/** Delay before retrying a job that failed `failures` times in a row: 15 s, 30 s, 60 s ... to 10 minutes, never longer than its interval. */
export function retryDelayMs(failures: number, everyMs: number): number {
  return Math.min(everyMs, jobBackoffMs(failures));
}

/** Event triggers and timer triggers share one non-overlapping slot per job. A job that throws is logged, recorded in
 * service_status and retried with backoff; it never stops the other jobs. */
export function createScheduler(sql: Db, logger: Logger) {
  const jobs = new Map<string, { definition: ServiceJob; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; pending: boolean; failures: number }>();
  let stopping = false;

  function schedule(name: string, delay: number) {
    const state = jobs.get(name);
    if (!state || stopping) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { void trigger(name); }, delay);
  }

  async function trigger(name: string): Promise<void> {
    const state = jobs.get(name);
    if (!state || stopping) return;
    if (state.running) { state.pending = true; return state.running; }
    if (state.timer) clearTimeout(state.timer);
    const definition = state.definition;
    const execute = async () => {
      const started = new Date().toISOString();
      let failed = false;
      let retryAfterMs: number | undefined;
      try {
        const defaults = JSON.stringify({ intervalMs: definition.everyMs });
        await sql`insert into service_status (job, last_run, meta) values (${name}, ${started}, ${defaults}::jsonb)
          on conflict (job) do update set last_run = excluded.last_run, meta = service_status.meta || excluded.meta`;
        const result = (await definition.run()) ?? {};
        if (typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0) {
          retryAfterMs = Math.max(1000, Math.min(definition.everyMs, result.retryAfterMs));
        }
        const meta = JSON.stringify(result);
        await sql`update service_status set last_ok = now(), last_error = null, meta = meta || ${meta}::jsonb where job = ${name}`;
        state.failures = 0;
      } catch (error) {
        failed = true;
        state.failures++;
        const summary = safeErrorSummary(error);
        logger.error({ job: name, err: summary }, "Service job failed; next trigger will retry");
        try {
          await sql`insert into service_status (job, last_run, last_error) values (${name}, ${started}, ${summary.message})
            on conflict (job) do update set last_run = excluded.last_run, last_error = excluded.last_error`;
        } catch (statusError) {
          logger.warn({ err: safeErrorSummary(statusError) }, "Could not record job failure");
        }
      } finally {
        delete state.running;
        const nextInterval = failed ? retryDelayMs(state.failures, definition.everyMs) : retryAfterMs ?? definition.everyMs;
        const delay = state.pending ? 0 : nextInterval + Math.floor(Math.random() * (definition.jitterMs ?? 0));
        state.pending = false;
        schedule(name, delay);
      }
    };
    state.running = execute();
    return state.running;
  }

  return {
    add(job: ServiceJob) {
      if (jobs.has(job.name) || job.everyMs <= 0) throw new Error(`Invalid or duplicate service job: ${job.name}`);
      jobs.set(job.name, { definition: job, pending: false, failures: 0 });
      schedule(job.name, job.initialDelayMs ?? 0);
    },
    trigger,
    async stop() {
      stopping = true;
      for (const state of jobs.values()) if (state.timer) clearTimeout(state.timer);
      await Promise.all([...jobs.values()].map((state) => state.running));
    },
  };
}

// --------------------------------------------------------------------------------------------------------- single-instance lock
/** Advisory-lock class ("ODRV") and one id per service. Only the session holding it may sign, so two instances never race for a nonce. */
const LOCK_CLASS = 0x4f445256;
export const SERVICE_LOCK_IDS = { crank: 1, hedger: 2, liquidator: 3 } as const;
export type LockedService = keyof typeof SERVICE_LOCK_IDS;

export interface ServiceLock {
  /** "held" while this process still holds the lock, "lost" if another session holds it, "unknown" on database errors. */
  check(): Promise<"held" | "lost" | "unknown">;
  release(): Promise<void>;
}

/** Waits until the service's single-instance lock is held on one dedicated connection. Returns undefined if aborted first. */
export async function acquireServiceLock(
  databaseUrl: string,
  service: LockedService,
  logger: Logger,
  signal: AbortSignal,
  retryMs = 15_000,
): Promise<ServiceLock | undefined> {
  const lockId = SERVICE_LOCK_IDS[service];
  // One long-lived connection: a session-level advisory lock dies with its session, so it must not be recycled.
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10, onnotice: () => undefined });
  const tryLock = async () => {
    const rows = await sql<{ held: boolean }[]>`
      select exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
        and classid = ${LOCK_CLASS} and objid = ${lockId} and objsubid = 2 and granted)
        or pg_try_advisory_lock(${LOCK_CLASS}::int4, ${lockId}::int4) as held`;
    return rows[0]?.held === true;
  };
  let warned = false;
  while (!signal.aborted) {
    try {
      if (await tryLock()) {
        logger.info({ service }, "Single-instance lock acquired");
        return {
          check: async () => {
            try { return (await tryLock()) ? "held" : "lost"; } catch (error) {
              logger.warn({ err: safeErrorSummary(error), service }, "Lock check failed");
              return "unknown";
            }
          },
          release: async () => { await sql.end({ timeout: 5 }).catch(() => undefined); },
        };
      }
      if (!warned) logger.error({ service }, "Another instance holds the single-instance lock; waiting to take over");
      warned = true;
    } catch (error) {
      logger.warn({ err: safeErrorSummary(error), service }, "Lock acquisition failed; retrying");
    }
    await sleep(retryMs, undefined, { signal }).catch(() => undefined);
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
  return undefined;
}
