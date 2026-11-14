import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { optionalEnv } from "../config";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "../../drizzle");

/** The URL of the throwaway (or caller supplied) server, or undefined when database tests must be skipped. */
export function testDatabaseUrl(): string | undefined {
  return optionalEnv("TEST_DATABASE_URL");
}

export interface TestDatabase {
  readonly sql: Sql;
  readonly name: string;
  readonly close: () => Promise<void>;
}

/** Creates an empty database on the test server. Every test file gets its own, so files cannot interfere. */
export async function createTestDatabase(label: string): Promise<TestDatabase | undefined> {
  const url = testDatabaseUrl();
  if (!url) return undefined;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const name = `t_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end({ timeout: 5 });
  const target = new URL(url);
  target.pathname = `/${name}`;
  const sql = postgres(target.toString(), { max: 4, onnotice: () => undefined, transform: { undefined: null } });
  return {
    sql,
    name,
    close: async () => {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(url, { max: 1, onnotice: () => undefined });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end({ timeout: 5 });
    },
  };
}

/** Runs the real drizzle migrator over the repo's migration files. `upTo` stops after that many migrations (so a test
 * can build an "old" database and migrate it forward). */
export async function applyMigrations(db: TestDatabase, upTo?: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "od-migrations-"));
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    if (upTo !== undefined) {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, upTo);
      writeFileSync(journalPath, JSON.stringify(journal));
    }
    await migrate(drizzle(db.sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
