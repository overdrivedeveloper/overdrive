import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyResults, loadResults, saveResults, shouldRun, summary, toMarkdown, upsertRow, type ResultRow } from "./results";

const row = (id: string, status: ResultRow["status"]): ResultRow => ({
  id, area: "holders", name: `flow ${id}`, kind: "success", status, txs: [{ label: "t", hash: "0xabc", gas: "1", status: "success" }],
  chain: { asserted: 2, ok: status === "pass" }, api: { asserted: 1, ok: status === "pass" }, notes: "", startedAt: "2026-01-01T00:00:00.000Z", ms: 1,
});

describe("results", () => {
  test("resume_skips_passed_reruns_failed", () => {
    let f = emptyResults();
    f = upsertRow(f, row("H01", "pass"));
    f = upsertRow(f, row("H02", "fail"));
    f = upsertRow(f, row("H03", "blocked"));
    expect(shouldRun(f, "H01", true)).toBe(false);
    expect(shouldRun(f, "H02", true)).toBe(true);
    expect(shouldRun(f, "H03", true)).toBe(true); // a blocked flow is retried: the service may exist now
    expect(shouldRun(f, "H04", true)).toBe(true);
    expect(shouldRun(f, "H01", false)).toBe(true);
    expect(summary(f)).toEqual({ total: 3, pass: 1, fail: 1, blocked: 1 });
  });

  test("a crash leaves a valid file and a rerun replaces the row", () => {
    const file = join(mkdtempSync(join(tmpdir(), "res-")), "results.json");
    saveResults(upsertRow(emptyResults(), row("H01", "fail")), file);
    expect(loadResults(file).rows).toHaveLength(1);
    saveResults(upsertRow(loadResults(file), row("H01", "pass")), file);
    const again = loadResults(file);
    expect(again.rows).toHaveLength(1);
    expect(again.rows[0]!.status).toBe("pass");
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  test("markdown has one table per area with every transaction", () => {
    const md = toMarkdown(upsertRow(upsertRow(emptyResults(), row("H01", "pass")), { ...row("B01", "blocked"), area: "backers", error: "no vault" }));
    expect(md).toContain("## holders: 1/1 passed");
    expect(md).toContain("## backers: 0/1 passed, 0 failed, 1 blocked");
    expect(md).toContain("| 0xabc |");
  });
});
