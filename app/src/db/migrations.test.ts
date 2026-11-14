import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema";
import { applyMigrations, createTestDatabase, MIGRATIONS_DIR, testDatabaseUrl, type TestDatabase } from "../testing/db";

const JOURNAL_COUNT: number = (JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
const suite = testDatabaseUrl() ? describe : describe.skip;

const SPEC_TABLES = ["gears", "nf_history", "backer_vaults", "governor_ledger", "fees", "trades", "transfers", "balances", "prices", "vol_posts", "queued_sells",
  "liquidation_batches", "liquidations", "pause_log", "stock_events", "exit_reserve_log", "indexer_skipped_events", "cursors", "block_hashes", "reorg_log",
  "service_status", "jobs", "job_schedule", "stake_events", "agent_policies", "agent_trades", "admin_events", "entity_events",
  "earnings_dates", "vol_post_intents", "vol_alerts"];

async function tables(db: TestDatabase): Promise<Set<string>> {
  const rows = await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  return new Set(rows.map((row) => String(row.table_name)));
}
async function columns(db: TestDatabase, table: string): Promise<string[]> {
  const rows = await db.sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
  return rows.map((row) => String(row.column_name));
}
async function snapshot(db: TestDatabase): Promise<string> {
  const rows = await db.sql`SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`;
  const idx = await db.sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`;
  return JSON.stringify([rows, idx]);
}

suite("migrations", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("migrations"))!; });
  afterAll(async () => db.close());

  test("applies_twice_idempotent", async () => {
    await applyMigrations(db);
    const first = await snapshot(db);
    const ledger = await db.sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(ledger[0]!.n).toBe(JOURNAL_COUNT);
    await applyMigrations(db); // already migrated: no error, no change
    expect(await snapshot(db)).toBe(first);
    expect((await db.sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n).toBe(JOURNAL_COUNT);
    // forward from a half-migrated database
    const partial = (await createTestDatabase("partial"))!;
    try {
      await applyMigrations(partial, 1);
      expect((await tables(partial)).has("trades")).toBe(false);
      await applyMigrations(partial);
      expect(await snapshot(partial)).toBe(first);
    } finally {
      await partial.close();
    }
    // the raw migrator over the repo folder, run again, also does nothing
    await migrate(drizzle(db.sql), { migrationsFolder: MIGRATIONS_DIR });
    expect(await snapshot(db)).toBe(first);
  });

  test("every spec table exists with its spec columns", async () => {
    const present = await tables(db);
    for (const name of SPEC_TABLES) expect(present.has(name), name).toBe(true);
    expect(await columns(db, "gears")).toEqual(expect.arrayContaining(["id", "market_a", "market_b", "underlying", "underlying_b", "power", "power_wad", "token", "cap_usd", "spread_bps", "status", "nf", "last_accrual", "listed_block", "listed_at"]));
    expect(await columns(db, "nf_history")).toEqual(expect.arrayContaining(["gear", "ts", "block", "tx_hash", "log_index", "nf", "toll", "toll_value_usd_wad", "sigma_hat", "usage", "session"]));
    expect(await columns(db, "governor_ledger")).toEqual(expect.arrayContaining(["ts", "underlying", "delta", "gamma", "hedge_delta", "equity", "exit_reserve", "block"]));
    expect(await columns(db, "jobs")).toEqual(expect.arrayContaining(["id", "kind", "dedupe_key", "payload", "run_at", "status", "attempts", "max_attempts", "locked_by", "locked_until", "last_error", "result"]));
  });

  test("no timescale: plain tables only", async () => {
    const ext = await db.sql`SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`;
    expect(ext.length).toBe(0);
  });

  test("schema.ts describes exactly the tables and columns the migrations create", async () => {
    const declared = Object.values(schema).filter((value) => is(value, PgTable)) as unknown as PgTable[];
    expect(declared.length).toBe(SPEC_TABLES.length);
    for (const table of declared) {
      const config = getTableConfig(table);
      const actual = (await columns(db, config.name)).sort();
      expect(actual.length, `table ${config.name} exists`).toBeGreaterThan(0);
      expect(config.columns.map((column) => column.name).sort(), config.name).toEqual(actual);
    }
    const known = new Set<string>(declared.map((table) => getTableConfig(table).name));
    expect([...(await tables(db))].filter((name) => !known.has(name))).toEqual([]);
  });
});
