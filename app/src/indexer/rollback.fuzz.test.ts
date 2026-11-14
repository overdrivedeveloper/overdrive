import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { createIngest, MAX_REORG_DEPTH } from "./ingest";
import { drain, dump, FakeChain, newState, randomBlockLogs, resetDb, seeded, testDeployment } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);

suite("rollback fuzz", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("fuzz"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => db.close());

  test("random_fork_sequences_converge", async () => {
    for (let run = 0; run < RUNS; run++) {
      const rand = seeded(1000 + run);
      await resetDb(db.sql);
      const chain = new FakeChain();
      let step = 0;
      const extend = (n: number) => { for (let i = 0; i < n; i++) chain.add(randomBlockLogs(d, rand, step++)); };
      extend(3 + Math.floor(rand() * 6));
      const state = await newState(db.sql, chain);
      const ingest = createIngest(state);
      await ingest.tick();
      for (let round = 0; round < 3; round++) {
        extend(1 + Math.floor(rand() * 4));
        if (rand() < 0.7) {
          const depth = BigInt(1 + Math.floor(rand() * Math.min(Number(MAX_REORG_DEPTH) - 2, Number(chain.head) - 1)));
          const ancestor = chain.head - depth;
          const branch = Array.from({ length: Number(depth) + Math.floor(rand() * 3) }, () => randomBlockLogs(d, rand, step++));
          chain.fork(ancestor, branch);
        }
        await ingest.tick();
        await drain(state);
      }
      const forked = await dump(db.sql);
      // invariants: balances = sum of transfers, gears.nf = latest history
      const bad = await db.sql`
        SELECT b.account FROM balances b WHERE b.balance <> COALESCE((SELECT SUM(CASE WHEN t.to_addr = b.account THEN t.amount ELSE 0 END) - SUM(CASE WHEN t.from_addr = b.account THEN t.amount ELSE 0 END) FROM transfers t WHERE t.token = b.token), 0)`;
      expect(bad.length, `run ${run} balances`).toBe(0);
      const nfBad = await db.sql`SELECT g.id FROM gears g WHERE g.nf <> COALESCE((SELECT nf FROM nf_history h WHERE h.gear = g.id ORDER BY block DESC, log_index DESC LIMIT 1), 1000000000000000000)`;
      expect(nfBad.length, `run ${run} nf`).toBe(0);
      // a clean run over the final canonical chain gives the same rows
      await resetDb(db.sql);
      await drain(await newState(db.sql, chain));
      expect(await dump(db.sql), `run ${run} converges`).toEqual(forked);
    }
  }, 600_000);
});
