import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createDbClient } from "./client";
import { assertReadOnlyRole, WritableRoleError } from "./readonly";
import { applyMigrations, createTestDatabase, readOnlyRoleUrl, testDatabaseUrl } from "../testing/db";

const db = await createTestDatabase("readonly");
afterAll(async () => { await db?.close(); });

test("boot_refuses_writable_role", async () => {
  if (!db) return;
  await applyMigrations(db);
  // the migrating (owner) role can write: boot must refuse it
  await expect(assertReadOnlyRole(db.sql)).rejects.toBeInstanceOf(WritableRoleError);
  const url = new URL(await readOnlyRoleUrl(db.sql, db.name)); // runs scripts/api-readonly-role.sql
  const ro = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    await assertReadOnlyRole(ro); // the SELECT-only role passes
    expect((await ro`SELECT count(*)::int AS n FROM gears`)[0]!.n).toBe(0);
    await expect(ro`INSERT INTO cursors (name, block) VALUES ('x', 1)`).rejects.toThrow();
    await expect(ro`TRUNCATE gears`).rejects.toThrow();
    await expect(ro.unsafe("CREATE TABLE sneaky (a int)")).rejects.toThrow();
  } finally { await ro.end({ timeout: 2 }); }
  // grants are re-runnable and a later table is readable but not writable by default privileges only for new owner tables
  await db.sql.unsafe(readFileSync(join(import.meta.dir, "..", "..", "scripts", "api-readonly-role.sql"), "utf8"));
});

test("sessions open read only even for a role that could write", async () => {
  if (!db) return;
  const url = new URL(testDatabaseUrl()!); url.pathname = `/${db.name}`;
  const { sql } = createDbClient({ DATABASE_URL: url.toString() }, { readOnly: true });
  try {
    await expect(sql`INSERT INTO cursors (name, block) VALUES ('y', 1)`).rejects.toThrow(/read-only/i);
    expect((await sql`SHOW default_transaction_read_only`)[0]!.default_transaction_read_only).toBe("on");
  } finally { await sql.end({ timeout: 2 }); }
});
