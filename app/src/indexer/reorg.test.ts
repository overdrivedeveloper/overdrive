import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

import { createIngest, MAX_REORG_DEPTH, ReorgTooDeepError } from "./ingest";
import { accrued, bought, dump, drain, FakeChain, GEAR_1, listGear, MARKET_TSLA, newState, resetDb, TOKEN_1, transfer, testDeployment, USERS, ZERO } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();
type Logs = Parameters<FakeChain["add"]>[0];

const common: Logs[] = [[listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)], [transfer(TOKEN_1, ZERO, USERS[0]!, 1000n)], [accrued(d, GEAR_1, 99n * 10n ** 16n)]];
const orphaned: Logs[] = [[transfer(TOKEN_1, USERS[0]!, USERS[1]!, 400n), accrued(d, GEAR_1, 5n * 10n ** 17n)], [bought(d, GEAR_1, USERS[2]!, 10n, 20n)], [transfer(TOKEN_1, ZERO, USERS[3]!, 77n)]];
const winning: Logs[] = [[transfer(TOKEN_1, USERS[0]!, USERS[2]!, 250n)], [accrued(d, GEAR_1, 8n * 10n ** 17n)], [], [transfer(TOKEN_1, USERS[2]!, USERS[3]!, 5n)]];

suite("reorg", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("reorg"))!; await applyMigrations(db); });
  afterAll(async () => db.close());

  test("rollback_and_reingest_matches_clean_run", async () => {
    const forked = new FakeChain();
    for (const logs of [...common, ...orphaned]) forked.add(logs);
    const state = await newState(db.sql, forked);
    await drain(state);
    expect((await db.sql`SELECT nf FROM gears`)[0]!.nf).toBe("500000000000000000");
    forked.fork(3n, winning); // blocks 4.. replaced
    const result = await createIngest(state).tick();
    expect(result.reorg?.ancestor).toBe(3n);
    await drain(state);
    const afterFork = await dump(db.sql);
    const log = await db.sql`SELECT ancestor::int AS a, depth::int AS depth, rows_removed FROM reorg_log`;
    expect(log.length).toBe(1);
    expect(log[0]!.a).toBe(3);
    expect(log[0]!.depth).toBe(3);
    expect(log[0]!.rows_removed).toBeGreaterThan(0);

    await resetDb(db.sql);
    const clean = new FakeChain();
    for (const logs of [...common, ...winning]) clean.add(logs);
    await drain(await newState(db.sql, clean));
    expect(await dump(db.sql)).toEqual(afterFork);
    expect((await db.sql`SELECT nf FROM gears`)[0]!.nf).toBe("800000000000000000");
  });

  test("too_deep_stops", async () => {
    await resetDb(db.sql);
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)]);
    for (let i = 0; i < 30; i++) chain.add([transfer(TOKEN_1, ZERO, USERS[0]!, 1n)]);
    const state = await newState(db.sql, chain);
    await drain(state);
    chain.fork(31n - MAX_REORG_DEPTH - 3n, Array.from({ length: 30 }, () => [transfer(TOKEN_1, ZERO, USERS[1]!, 2n)]));
    await expect(createIngest(state).tick()).rejects.toBeInstanceOf(ReorgTooDeepError);
    const status = await db.sql`SELECT last_error FROM service_status WHERE job = 'indexer'`;
    expect(status[0]!.last_error).toContain("exceeds the automatic limit");
    // nothing was silently skipped: balances still reflect the first branch
    expect((await db.sql`SELECT balance FROM balances WHERE account = ${USERS[1]!.toLowerCase()}`).length).toBe(0);
  });
});
