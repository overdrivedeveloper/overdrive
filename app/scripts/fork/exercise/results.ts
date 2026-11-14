// results.json: one row per exercised flow (todo 22 R9, R10). Written atomically after every row so a crash leaves a valid
// file; `--resume` skips rows that passed and reruns failed and blocked ones.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FORK_DIR } from "../lib";

export type Status = "pass" | "fail" | "blocked";
export interface TxRecord { label: string; hash: string; gas: string; status: "success" | "reverted" | "simulated"; revert?: string }
export interface Side { asserted: number; ok: boolean }
export interface ResultRow {
  id: string;
  area: string;
  name: string;
  kind: "success" | "expected_failure";
  status: Status;
  txs: TxRecord[];
  chain: Side;
  api: Side;
  notes: string;
  /** Failure or block reason, with both values of a mismatch. */
  error?: string;
  startedAt: string;
  ms: number;
}
export interface ResultsFile { version: 1; forkBlock?: string; updatedAt: string; rows: ResultRow[] }

export const RESULTS_FILE = process.env.EXERCISE_RESULTS ?? join(FORK_DIR, "results.json");

export function emptyResults(): ResultsFile { return { version: 1, updatedAt: new Date(0).toISOString(), rows: [] }; }

export function loadResults(file = RESULTS_FILE): ResultsFile {
  if (!existsSync(file)) return emptyResults();
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as ResultsFile;
    return f.version === 1 && Array.isArray(f.rows) ? f : emptyResults();
  } catch { return emptyResults(); }
}

/** Atomic write: temp file in the same folder, then rename. */
export function saveResults(f: ResultsFile, file = RESULTS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...f, updatedAt: new Date().toISOString() }, null, 1)}\n`);
  renameSync(tmp, file);
}

/** Insert or replace by id (keeps first-seen order). */
export function upsertRow(f: ResultsFile, row: ResultRow): ResultsFile {
  const i = f.rows.findIndex((r) => r.id === row.id);
  const rows = i < 0 ? [...f.rows, row] : f.rows.map((r, j) => (j === i ? row : r));
  return { ...f, rows };
}

/** R10: only a row that passed is skipped on resume. */
export function shouldRun(f: ResultsFile, id: string, resume: boolean): boolean {
  if (!resume) return true;
  return f.rows.find((r) => r.id === id)?.status !== "pass";
}

export function summary(f: ResultsFile, ids?: readonly string[]): { total: number; pass: number; fail: number; blocked: number } {
  const rows = ids ? f.rows.filter((r) => ids.includes(r.id)) : f.rows;
  const n = (s: Status) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, pass: n("pass"), fail: n("fail"), blocked: n("blocked") };
}

const one = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}...` : s).replace(/\|/g, "/").replace(/\n/g, " ");

/** Markdown table per area, every transaction listed under its row. */
export function toMarkdown(f: ResultsFile): string {
  const areas = [...new Set(f.rows.map((r) => r.area))];
  const out: string[] = [`# Fork exercise results`, ``, `Updated ${f.updatedAt}${f.forkBlock ? `, fork block ${f.forkBlock}` : ""}.`, ``];
  for (const area of areas) {
    const rows = f.rows.filter((r) => r.area === area);
    const s = summary(f, rows.map((r) => r.id));
    out.push(`## ${area}: ${s.pass}/${s.total} passed, ${s.fail} failed, ${s.blocked} blocked`, ``, `| Id | Flow | Result | Chain | API | Txs | Note |`, `|---|---|---|---|---|---|---|`);
    for (const r of rows) {
      out.push(`| ${r.id} | ${one(r.name, 70)} | ${r.status.toUpperCase()} | ${r.chain.asserted} | ${r.api.asserted} | ${r.txs.length} | ${one(r.error ?? r.notes)} |`);
    }
    out.push(``);
    for (const r of rows) {
      if (r.txs.length === 0) continue;
      out.push(`### ${r.id} transactions`, ``, `| Label | Hash | Gas | Status |`, `|---|---|---|---|`);
      for (const t of r.txs) out.push(`| ${one(t.label, 60)} | ${t.hash} | ${t.gas} | ${t.status}${t.revert ? ` (${t.revert})` : ""} |`);
      out.push(``);
    }
  }
  return `${out.join("\n")}\n`;
}
