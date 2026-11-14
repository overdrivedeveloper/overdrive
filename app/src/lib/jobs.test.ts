import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pino from "pino";
import postgres from "postgres";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { acquireServiceLock, claim, complete, createScheduler, enqueue, fail, jobBackoffMs, retryDelayMs, runDueSchedules } from "./jobs";

const suite = testDatabaseUrl() ? describe : describe.skip;
const logger = pino({ level: "silent" });

test("backoff schedule is 15 s doubling to 10 min", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(jobBackoffMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  expect(retryDelayMs(1, 10_000)).toBe(10_000);
  expect(retryDelayMs(3, 3_600_000)).toBe(60_000);
});

suite("jobs", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("jobs"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close());

  test("enqueue_is_idempotent", async () => {
    const a = await enqueue(db.sql, { kind: "idem", dedupeKey: "k1", payload: { n: 1 } });
    const b = await enqueue(db.sql, { kind: "idem", dedupeKey: "k1", payload: { n: 2 } });
    const c = await enqueue(db.sql, { kind: "idem", dedupeKey: "k2" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(c.created).toBe(true);
    expect(c.id).not.toBe(a.id);
    const rows = await db.sql`select payload from jobs where id = ${a.id.toString()}`;
    expect(rows[0]!.payload).toEqual({ n: 1 });
  });

  test("claim_is_exclusive", async () => {
    for (let i = 0; i < 200; i++) await enqueue(db.sql, { kind: "excl", dedupeKey: `j${i}` });
    const processed = new Map<string, string[]>();
    const worker = async (name: string) => {
      for (;;) {
        const jobs = await claim(db.sql, name, ["excl"], { seconds: 60 }, 5);
        if (jobs.length === 0) return;
        for (const job of jobs) {
          processed.set(job.dedupeKey, [...(processed.get(job.dedupeKey) ?? []), name]);
          await complete(db.sql, job.id, { by: name });
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => worker(`w${i}`)));
    expect(processed.size).toBe(200);
    for (const [key, by] of processed) expect(by.length, key).toBe(1);
    const done = await db.sql`select count(*)::int as n from jobs where kind = 'excl' and status = 'done'`;
    expect(done[0]!.n).toBe(200);
  });

  test("lease_expiry_reclaims", async () => {
    const { id } = await enqueue(db.sql, { kind: "lease", dedupeKey: "a" });
    const first = await claim(db.sql, "w1", ["lease"], { seconds: 600 });
    expect(first.map((j) => j.id)).toEqual([id]);
    expect(await claim(db.sql, "w2", ["lease"], { seconds: 600 })).toEqual([]);
    await db.sql`update jobs set locked_until = now() - interval '1 second' where id = ${id.toString()}`;
    const again = await claim(db.sql, "w2", ["lease"], { seconds: 600 });
    expect(again.length).toBe(1);
    expect(again[0]!.lockedBy).toBe("w2");
    expect(again[0]!.attempts).toBe(2);
    expect(await claim(db.sql, "w3", ["other-kind"], { seconds: 60 })).toEqual([]);
  });

  test("backoff_and_dead_letter", async () => {
    const { id } = await enqueue(db.sql, { kind: "dead", dedupeKey: "a", maxAttempts: 4 });
    const expectedDelays = [15, 30, 60];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await db.sql`update jobs set run_at = now() where id = ${id.toString()}`;
      const [job] = await claim(db.sql, "w", ["dead"], { seconds: 60 });
      expect(job!.id).toBe(id);
      expect(job!.attempts).toBe(attempt);
      await fail(db.sql, id, `boom ${attempt}`);
      const row = (await db.sql`select status, last_error, extract(epoch from run_at - now()) as wait from jobs where id = ${id.toString()}`)[0]!;
      if (attempt < 4) {
        expect(row.status).toBe("queued");
        expect(Math.round(Number(row.wait))).toBe(expectedDelays[attempt - 1]!);
        expect(await claim(db.sql, "w", ["dead"], { seconds: 60 })).toEqual([]); // not due yet
      } else {
        expect(row.status).toBe("dead");
        expect(row.last_error).toBe("boom 4");
      }
    }
    const status = await db.sql`select last_error from service_status where job = 'jobs:dead'`;
    expect(status[0]!.last_error).toContain("dead job");
    await db.sql`update jobs set run_at = now() where id = ${id.toString()}`;
    expect(await claim(db.sql, "w", ["dead"], { seconds: 60 })).toEqual([]);
  });

  test("schedules become deduped jobs", async () => {
    const past = new Date(Date.now() - 1000);
    await db.sql`insert into job_schedule (name, every_ms, next_run_at) values ('sched-a', 60000, ${past.toISOString()}::timestamptz), ('sched-b', 60000, ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz)`;
    const now = new Date();
    expect(await runDueSchedules(db.sql, now)).toEqual(["sched-a"]);
    expect(await runDueSchedules(db.sql, now)).toEqual([]);
    const jobs = await claim(db.sql, "w", ["sched-a", "sched-b"], { seconds: 60 }, 10);
    expect(jobs.map((j) => j.kind)).toEqual(["sched-a"]);
  });

  test("scheduler records success and failure in service_status", async () => {
    const scheduler = createScheduler(db.sql, logger);
    let runs = 0;
    scheduler.add({ name: "ok-job", everyMs: 3_600_000, initialDelayMs: 3_600_000, run: async () => { runs++; return { seen: runs }; } });
    scheduler.add({ name: "bad-job", everyMs: 3_600_000, initialDelayMs: 3_600_000, run: async () => { throw new Error("nope"); } });
    await scheduler.trigger("ok-job");
    await scheduler.trigger("bad-job");
    await scheduler.stop();
    const ok = (await db.sql`select last_ok, meta from service_status where job = 'ok-job'`)[0]!;
    expect(ok.last_ok).not.toBeNull();
    expect(ok.meta.seen).toBe(1);
    const bad = (await db.sql`select last_error from service_status where job = 'bad-job'`)[0]!;
    expect(bad.last_error).toContain("nope");
  });

  test("single_instance_lock", async () => {
    const url = new URL(testDatabaseUrl()!);
    url.pathname = `/${db.name}`;
    const controller = new AbortController();
    const first = await acquireServiceLock(url.toString(), "crank", logger, controller.signal, 50);
    expect(first).toBeDefined();
    expect(await first!.check()).toBe("held");
    // a different service name has its own lock
    const other = await acquireServiceLock(url.toString(), "hedger", logger, controller.signal, 50);
    expect(other).toBeDefined();
    // a second crank instance waits...
    let secondLock: Awaited<ReturnType<typeof acquireServiceLock>>;
    const second = acquireServiceLock(url.toString(), "crank", logger, controller.signal, 50).then((lock) => { secondLock = lock; return lock; });
    await Bun.sleep(300);
    expect(secondLock).toBeUndefined();
    // ...and takes over after the first closes
    await first!.release();
    const taken = await second;
    expect(taken).toBeDefined();
    expect(await taken!.check()).toBe("held");
    await taken!.release();
    await other!.release();
    // lost: the holder's session is killed and another session takes the lock
    const holder = await acquireServiceLock(url.toString(), "liquidator", logger, controller.signal, 50);
    const admin = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      await admin`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and classid = ${0x4f445256} and objid = 3 and pid <> pg_backend_pid()`;
      const thief = await acquireServiceLock(url.toString(), "liquidator", logger, controller.signal, 50);
      expect(thief).toBeDefined();
      expect(await holder!.check()).toBe("lost");
      await thief!.release();
    } finally {
      await holder!.release();
      await admin.end({ timeout: 5 });
    }
  });
});
