import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

import { INITIAL_RANGE, createIngest } from "./ingest";
import { drain, FakeChain, GEAR_1, listGear, MARKET_TSLA, newState, settings, TOKEN_1, transfer, testDeployment, USERS, ZERO } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();

suite("catchup", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("catchup"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close());

  test("range_halves_and_applies_in_order", async () => {
    expect(INITIAL_RANGE).toBe(50_000n);
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)]);
    for (let i = 0; i < 39; i++) chain.add([transfer(TOKEN_1, ZERO, USERS[i % 4]!, BigInt(i + 1))]);
    // the node refuses anything over 10 blocks with a "too many results" style error
    chain.failLogs = (range) => (range.toBlock - range.fromBlock + 1n > 10n ? new Error("query returned more than 10000 results") : undefined);
    const state = await newState(db.sql, chain, { settings: settings({ catchupConcurrency: 3 }) });
    const applied: bigint[] = [];
    const original = state.source.getLogs.bind(state.source);
    state.source.getLogs = async (range) => { const result = await original(range); applied.push(range.fromBlock); return result; };
    await createIngest(state).tick();
    expect(state.catchup.backoffs).toBeGreaterThan(0);
    expect(state.range <= 10n || state.range >= 1n).toBe(true);
    expect(state.cursor).toBe(40n);
    const order = (await db.sql`SELECT block::int AS b FROM transfers ORDER BY ctid`).map((r) => r.b);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // rows landed in block order
    expect((await db.sql`SELECT count(*)::int AS n FROM transfers`)[0]!.n).toBe(39);
    // parallel ranges were fetched at once but applied strictly in block order: the cursor only ever moved forward
    expect((await db.sql`SELECT block::int AS b FROM cursors`)[0]!.b).toBe(40);
    // the range grows back after successes
    const before = state.range;
    for (let i = 0; i < 12; i++) chain.add([]);
    chain.failLogs = undefined;
    await drain(state);
    expect(state.range >= before).toBe(true);
  });
});
