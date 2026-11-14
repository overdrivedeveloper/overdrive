import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { busyOr, decodeTimeCursor, encodeTimeCursor, publicReads } from "./public-read";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

describe("time cursors", () => {
  test("round trip, and junk is refused", () => {
    const cursor = { ts: "2026-10-28T10:00:00.000Z", txHash: "0xabc", logIndex: 3 };
    expect(decodeTimeCursor(encodeTimeCursor(cursor))).toEqual(cursor);
    for (const bad of ["", "nonsense", "x".repeat(500), Buffer.from(JSON.stringify({ ts: "2026-10-28", txHash: "abc", logIndex: 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ts: "2026-10-28", txHash: "0x1", logIndex: -1 })).toString("base64url")]) {
      expect(decodeTimeCursor(bad)).toBeNull();
    }
  });
});

const suite = testDatabaseUrl() ? describe : describe.skip;
let db: TestDatabase;

suite("publicReads (statement timeout and slots)", () => {
  beforeAll(async () => { db = (await createTestDatabase("publicreads"))!; });
  afterAll(async () => db?.close(), 60_000);

  test("a slow query is cut by the statement timeout and answers 503, not 500", async () => {
    const reads = publicReads({ sql: db.sql }, { timeoutMs: 200 });
    const app = new Hono();
    app.get("/slow", async (context) => {
      try {
        await reads.run((sql) => sql`SELECT pg_sleep(2)`);
        return context.text("done");
      } catch (error) {
        return busyOr(context, error);
      }
    });
    const started = Date.now();
    const response = await app.request("/slow");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("reads run in a read-only transaction", async () => {
    const reads = publicReads({ sql: db.sql });
    await expect(reads.run((sql) => sql`CREATE TABLE should_not_exist (x int)`)).rejects.toThrow(/read-only/);
  });

  test("other errors are not turned into 503", async () => {
    const app = new Hono();
    app.get("/bad", (context) => busyOr(context, new Error("other")));
    app.onError((_error, context) => context.text("rethrown", 500));
    expect((await app.request("/bad")).status).toBe(500);
  });
});
