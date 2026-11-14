import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

import { createIngest } from "./ingest";
import { addressOf, volPosted, FakeChain, GEAR_1, listGear, MARKET_TSLA, newState, TOKEN_1, transfer, testDeployment, USERS, ZERO } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();

suite("poison events", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("poison"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close());

  test("skips_and_records", async () => {
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)]);
    // a handler that throws: Accrued rows reference nothing wrong, so force a failure with an out-of-range numeric (> 78 digits)
    const huge = volPosted(d, MARKET_TSLA, 5n, 2n ** 64n - 1n); // validUntil beyond the Date range: the handler throws
    // an undecodable log from a watched contract
    const garbage = { address: addressOf(d, "ODMinter"), data: "0x1234" as const, topics: ["0x" + "ab".repeat(32)] as `0x${string}`[] };
    chain.add([transfer(TOKEN_1, ZERO, USERS[0]!, 5n), huge, garbage as never, transfer(TOKEN_1, ZERO, USERS[1]!, 6n)]);
    chain.add([transfer(TOKEN_1, ZERO, USERS[2]!, 7n)]);
    const state = await newState(db.sql, chain);
    await createIngest(state).tick();
    expect(state.cursor).toBe(chain.head); // the cursor still advanced
    const skipped = await db.sql`SELECT reason FROM indexer_skipped_events ORDER BY log_index`;
    expect(skipped.length).toBe(2);
    expect(skipped.map((r) => r.reason).join(" ")).toContain("undecodable");
    expect((await db.sql`SELECT count(*)::int AS n FROM transfers`)[0]!.n).toBe(3); // the good events around the poison ones landed
    const status = await db.sql`SELECT meta FROM service_status WHERE job = 'indexer'`;
    expect(status[0]!.meta.skippedEvents).toBe(2);
  });
});
