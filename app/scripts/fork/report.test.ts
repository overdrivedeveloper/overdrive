import { expect, test } from "bun:test";
import { buildHtml, buildMarkdown, bugsOf, gate, headline } from "./report";
import type { ResultRow, ResultsFile } from "./exercise/results";

const row = (id: string, area: string, status: ResultRow["status"], error?: string): ResultRow => ({
  id, area, name: `flow ${id}`, kind: "success", status, txs: [{ label: "t", hash: "0xab", gas: "21000", status: "success" }],
  chain: { asserted: 2, ok: status === "pass" }, api: { asserted: 1, ok: status === "pass" }, notes: "", ...(error ? { error } : {}), startedAt: "2026-01-01T00:00:00Z", ms: 1,
});
const file = (rows: ResultRow[]): ResultsFile => ({ version: 1, forkBlock: "123", updatedAt: "2026-01-01T00:00:00Z", rows });

test("headline_and_sections_present", () => {
  const f = file([row("A01", "admin", "pass"), row("P01", "parity", "fail", "[BUG-X] api cap: got 0 | other")]);
  expect(headline(f)).toBe("1/2 passed, known bugs: 1");
  const md = buildMarkdown(f, "2026-01-01");
  for (const h of ["## admin", "## parity", "## Failures and blocked rows", "## Bugs found", "## Fork relaxations", "Fork block 123", "A01 transactions"]) expect(md).toContain(h);
  expect(md).toContain("BUG-X");
  expect(buildHtml(f, "2026-01-01")).toContain("<h2>Bugs found</h2>");
});

test("gate_requires_zero_known_bugs", () => {
  expect(gate(file([row("A01", "admin", "pass")]))).toBe(true);
  expect(gate(file([row("A01", "admin", "fail")]))).toBe(false);
  expect(gate(file([]))).toBe(false);
  expect(bugsOf(file([row("A01", "admin", "pass", "[BUG-1] x")])).length).toBe(1);
  expect(gate(file([row("A01", "admin", "pass", "[BUG-1] x")]))).toBe(false);
});
