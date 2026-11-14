import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { createSqlHedgerStore, hedgeFillTotals } from "./hedges";

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("hedger store", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("hedgestore"))!; await applyMigrations(db); });
  afterAll(async () => db.close());

  test("client_id_unique_signals_single_open_status_merges", async () => {
    const store = createSqlHedgerStore(db.sql);
    const row = { ts: new Date(), venue: "mock", underlying: "TSLA", usd: -5_000_000n, px: 400n * 10n ** 18n, feesUsd: 1n, ref: "r1", reason: "band", dry: false, clientId: "0xabc" };
    expect(await store.recordHedge(row)).toBe(true);
    expect(await store.recordHedge({ ...row, usd: 9n })).toBe(false); // a fill is never counted twice
    expect((await store.hedgeByClientId("0xabc"))?.usd).toBe(-5_000_000n);
    expect(await store.hedgeByClientId("0xnone")).toBeNull();
    await store.recordHedge({ ...row, clientId: "0xdry", dry: true, usd: 7n });
    expect(await hedgeFillTotals(db.sql)).toEqual([{ underlying: "TSLA", venue: "mock", usd: -5_000_000n }]);
    expect((await db.sql`SELECT side FROM hedges WHERE client_id = '0xabc'`)[0]!.side).toBe("sell");

    await store.recordCycle({ ts: new Date(), underlying: "TSLA", deltaUsd: -1n, gammaUsd: 2n, positionUsd: 3n, residualUsd: -4n, bandUsd: 5n, action: "hold", reason: "cooldown", inputAgeS: 7 });
    expect((await db.sql`SELECT residual_usd::text AS r FROM hedge_cycles`)[0]!.r).toBe("-4");

    await store.raiseSignal("unhedged", "TSLA", { usd: "1" });
    await store.raiseSignal("unhedged", "TSLA", { usd: "2" });
    expect([...(await db.sql`SELECT detail FROM hedger_signals WHERE cleared_at IS NULL`)]).toEqual([{ detail: { usd: "2" } }]);
    await store.clearSignal("unhedged", "TSLA");
    await store.raiseSignal("unhedged", "TSLA", { usd: "3" });
    expect((await db.sql`SELECT count(*)::int AS n FROM hedger_signals`)[0]!.n).toBe(2);

    await store.writeStatus("hedger", true, { a: 1, big: 5n });
    await store.writeStatus("hedger", false, { b: 2 }, "boom");
    const s = (await db.sql`SELECT last_ok, last_error, meta FROM service_status WHERE job = 'hedger'`)[0]!;
    expect(s.last_ok).not.toBeNull();
    expect(s.last_error).toBe("boom");
    expect(s.meta).toEqual({ a: 1, big: "5", b: 2 });
  });
});
