import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// drizzle's migrator only runs files listed in meta/_journal.json: a .sql file without an entry is silently skipped.
describe("migration journal", () => {
  test("every_sql_migration_has_a_journal_entry_in_order", () => {
    const dir = resolve(import.meta.dir, "../../drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
    const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8"));
    const tags = journal.entries.map((e: { tag: string }) => e.tag);
    expect(tags).toEqual(files);
    const idx = journal.entries.map((e: { idx: number }) => e.idx);
    expect(idx).toEqual(idx.map((_: number, i: number) => i));
  });
});
