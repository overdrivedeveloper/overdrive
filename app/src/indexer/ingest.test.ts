import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

import { listenOverdriveEvents } from "../db/notify";
import { createIngest } from "./ingest";
import { accrued, bought, dump, drain, FakeChain, feeNotified, GEAR_1, listGear, MARKET_TSLA, newState, TOKEN_1, transfer, testDeployment, USERS, ZERO } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();

suite("ingest", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("ingest"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close());

  function build(): FakeChain {
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)]);
    chain.add([transfer(TOKEN_1, ZERO, USERS[0]!, 500n), accrued(d, GEAR_1, 9n * 10n ** 17n)]);
    chain.add([bought(d, GEAR_1, USERS[0]!, 100n, 200n, true), feeNotified(d, 3n)]);
    chain.add([transfer(TOKEN_1, USERS[0]!, USERS[1]!, 120n)]);
    return chain;
  }

  test("replay_same_range_is_noop", async () => {
    const chain = build();
    const state = await newState(db.sql, chain);
    await drain(state);
    const first = await dump(db.sql);
    expect(JSON.parse(first.trades!).length).toBe(1);
    expect(JSON.parse(first.balances!).length).toBe(2);
    // rewind the cursor and the stored hashes: the same range is ingested again
    await db.sql`UPDATE cursors SET block = 0 WHERE name = 'main'`;
    await db.sql`DELETE FROM block_hashes`;
    const again = await newState(db.sql, chain);
    await drain(again);
    expect(await dump(db.sql)).toEqual(first);
    const counts = await db.sql`SELECT (SELECT count(*) FROM transfers)::int AS t, (SELECT count(*) FROM nf_history)::int AS n`;
    expect(counts[0]).toEqual({ t: 2, n: 1 });
  });

  test("notifies_after_commit_only", async () => {
    const chain = build();
    const seen: unknown[] = [];
    const stop = await listenOverdriveEvents(db.sql, (event) => { seen.push(event); });
    // a failing snapshot read must not roll back or prevent the notify of committed data; a failing ingest must send nothing
    const failing = new FakeChain();
    failing.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)]);
    await db.sql`TRUNCATE cursors, block_hashes, gears, entity_events RESTART IDENTITY`;
    const broken = await newState(db.sql, failing);
    failing.getHeaders = async () => { throw new Error("rpc down"); };
    await expect(createIngest(broken).tick()).rejects.toThrow("rpc down");
    await Bun.sleep(150);
    expect(seen).toEqual([]);
    const fresh = await newState(db.sql, chain);
    await createIngest(fresh).tick();
    for (let i = 0; i < 50 && seen.length === 0; i++) await Bun.sleep(20);
    await stop();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const kinds = (seen[0] as { kinds: string[] }).kinds;
    expect(kinds).toEqual(expect.arrayContaining(["trade", "config"]));
    expect(typeof (seen[0] as { block: unknown }).block).toBe("string");
  });
});
