import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pino from "pino";
import { createScheduler, retryDelayMs } from "../lib/jobs";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

const suite = testDatabaseUrl() ? describe : describe.skip;
suite("crank scheduler", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("crankscheduler"))!; await applyMigrations(db); });
  afterAll(async () => db.close());

  test("failure_backoff_isolated", async () => {
    const scheduler = createScheduler(db.sql, pino({ level: "silent" }));
    let healthy = 0, broken = 0;
    scheduler.add({ name: "toll", everyMs: 40, run: async () => { healthy++; return { ok: true }; } });
    scheduler.add({ name: "poke", everyMs: 40, run: async () => { broken++; throw new Error("rpc down"); } });
    await Bun.sleep(400);
    await scheduler.stop();
    // the broken job backs off (15 s doubling, never past its own interval) and never stops the healthy one
    expect(healthy).toBeGreaterThan(4);
    expect(broken).toBeGreaterThanOrEqual(1);
    const rows = await db.sql<{ job: string; last_ok: Date | null; last_error: string | null }[]>`select job, last_ok, last_error from service_status where job in ('toll','poke') order by job`;
    expect(rows.find((r) => r.job === "toll")!.last_ok).not.toBeNull();
    expect(rows.find((r) => r.job === "toll")!.last_error).toBeNull();
    expect(rows.find((r) => r.job === "poke")!.last_error).toBe("rpc down");
    expect(retryDelayMs(1, 3_600_000)).toBe(15_000);
    expect(retryDelayMs(4, 3_600_000)).toBe(120_000);
    expect(retryDelayMs(20, 3_600_000)).toBe(600_000);
    expect(retryDelayMs(3, 60_000)).toBe(60_000);
  });
});
