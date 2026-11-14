// Report generator (todo 22 R11, R13): results.json -> docs/reports/fork-run-<date>.md and .html.
// bun scripts/fork/report.ts [--out <dir>]. Headline: "N/N passed, known bugs: K". The gate (R13) needs N/N and K = 0.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, loadForkConfig } from "./lib";
import { loadResults, type ResultRow, type ResultsFile } from "./exercise/results";

const BUG_RE = /\[(BUG[-A-Z0-9]*)\]\s*([^|]*)/g;

export interface Bug { id: string; rows: string[]; evidence: string }
export function bugsOf(f: ResultsFile): Bug[] {
  const m = new Map<string, Bug>();
  for (const r of f.rows) {
    for (const hit of (r.error ?? "").matchAll(BUG_RE)) {
      const b = m.get(hit[1]!) ?? { id: hit[1]!, rows: [], evidence: hit[2]!.trim().slice(0, 300) };
      if (!b.rows.includes(r.id)) b.rows.push(r.id);
      m.set(b.id, b);
    }
  }
  return [...m.values()];
}
export function headline(f: ResultsFile): string {
  const pass = f.rows.filter((r) => r.status === "pass").length;
  return `${pass}/${f.rows.length} passed, known bugs: ${bugsOf(f).length}`;
}
/** R13: done only when every row passed and no known bug is open. */
export function gate(f: ResultsFile): boolean {
  return f.rows.length > 0 && f.rows.every((r) => r.status === "pass") && bugsOf(f).length === 0;
}

const cell = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}...` : s).replace(/\|/g, "/").replace(/\n/g, " ");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function relaxationLines(): string[] {
  try {
    const r = loadForkConfig().relaxations;
    return [
      `R5.1 feed max age (open) ${r.feedMaxAgeSec} s and extended/closed ${r.feedMaxAgeClosedSec} s, applied through the timelock`,
      `R5.2 oracle reference band ${r.refBandBps} bps and reference max age ${r.refMaxAgeSec} s (feeds and pools are frozen at the fork block)`,
      "R5.3 market-closed windows extended so frozen feeds do not read stale after warps",
      "R5.4 mock Pyth priced from the real feeds for every market",
    ];
  } catch { return ["(fork config not readable)"]; }
}

export function buildMarkdown(f: ResultsFile, date: string): string {
  const out: string[] = [`# Fork run ${date}`, ``, `**${headline(f)}**`, ``, `Fork block ${f.forkBlock ?? "unknown"}, results updated ${f.updatedAt}.`, ``];
  const areas = [...new Set(f.rows.map((r) => r.area))];
  for (const a of areas) {
    const rows = f.rows.filter((r) => r.area === a);
    out.push(`## ${a}: ${rows.filter((r) => r.status === "pass").length}/${rows.length} passed`, ``, `| Id | Flow | Kind | Result | Chain | API | Txs | Note |`, `|---|---|---|---|---|---|---|---|`);
    for (const r of rows) out.push(`| ${r.id} | ${cell(r.name, 80)} | ${r.kind} | ${r.status.toUpperCase()} | ${r.chain.asserted} | ${r.api.asserted} | ${r.txs.length} | ${cell(r.error ?? r.notes)} |`);
    out.push(``);
    for (const r of rows.filter((x) => x.txs.length)) {
      out.push(`### ${r.id} transactions`, ``, `| Label | Hash | Gas | Status |`, `|---|---|---|---|`);
      for (const t of r.txs) out.push(`| ${cell(t.label, 70)} | ${t.hash} | ${t.gas} | ${t.status}${t.revert ? ` (${t.revert})` : ""} |`);
      out.push(``);
    }
  }
  const bad = f.rows.filter((r) => r.status !== "pass");
  out.push(`## Failures and blocked rows`, ``);
  if (!bad.length) out.push("None.", "");
  for (const r of bad) {
    const rev = r.txs.filter((t) => t.revert).map((t) => `${t.label}: ${t.revert}`).join("; ");
    out.push(`- **${r.id}** (${r.status}): ${cell(r.error ?? "no detail", 600)}${rev ? ` Reverts seen: ${rev}.` : ""}`);
  }
  out.push(``, `## Bugs found`, ``);
  const bugs = bugsOf(f);
  if (!bugs.length) out.push("None.", "");
  for (const b of bugs) out.push(`### ${b.id}`, ``, `Rows: ${b.rows.join(", ")}. Evidence: ${b.evidence}`, `Repro: \`bun scripts/fork/exercise/index.ts --only ${b.rows.join(",")}\` on a fresh fork (\`reset.sh\`, \`up.sh\`).`, ``);
  out.push(`## Fork relaxations (setup.ts, applied through the timelock)`, ``, ...relaxationLines().map((l) => `- ${l}`), ``);
  return `${out.join("\n")}\n`;
}

export function buildHtml(f: ResultsFile, date: string): string {
  const color = (r: ResultRow) => (r.status === "pass" ? "#1a7f37" : r.status === "blocked" ? "#9a6700" : "#cf222e");
  const rows = (a: string) => f.rows.filter((r) => r.area === a).map((r) => `<tr><td>${r.id}</td><td>${esc(r.name)}</td><td>${r.kind}</td><td style="color:${color(r)}"><b>${r.status.toUpperCase()}</b></td><td>${r.chain.asserted}</td><td>${r.api.asserted}</td><td>${r.txs.length}</td><td>${esc(cell(r.error ?? r.notes, 200))}</td></tr>`).join("");
  const areas = [...new Set(f.rows.map((r) => r.area))];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fork run ${date}</title>
<style>body{font:14px system-ui;margin:2rem;max-width:1200px}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}</style>
<h1>Fork run ${date}</h1><p><b>${esc(headline(f))}</b></p><p>Fork block ${esc(f.forkBlock ?? "unknown")}.</p>
${areas.map((a) => `<h2>${esc(a)}</h2><table><tr><th>Id</th><th>Flow</th><th>Kind</th><th>Result</th><th>Chain</th><th>API</th><th>Txs</th><th>Note</th></tr>${rows(a)}</table>`).join("")}
<h2>Bugs found</h2>${bugsOf(f).length ? `<ul>${bugsOf(f).map((b) => `<li><b>${esc(b.id)}</b> rows ${b.rows.join(", ")}: ${esc(b.evidence)}</li>`).join("")}</ul>` : "<p>None.</p>"}
<h2>Fork relaxations</h2><ul>${relaxationLines().map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Transactions</h2>${f.rows.filter((r) => r.txs.length).map((r) => `<h3>${r.id}</h3><table><tr><th>Label</th><th>Hash</th><th>Gas</th><th>Status</th></tr>${r.txs.map((t) => `<tr><td>${esc(t.label)}</td><td><code>${t.hash}</code></td><td>${t.gas}</td><td>${t.status}${t.revert ? ` (${esc(t.revert)})` : ""}</td></tr>`).join("")}</table>`).join("")}
</html>
`;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--out");
  const dir = resolve(i > 0 ? process.argv[i + 1]! : process.env.REPORT_DIR ?? join(ROOT, "..", "docs", "reports"));
  const f = loadResults();
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `fork-run-${date}.md`), buildMarkdown(f, date));
  writeFileSync(join(dir, `fork-run-${date}.html`), buildHtml(f, date));
  console.log(`${headline(f)}; gate ${gate(f) ? "open" : "closed"}; wrote ${dir}/fork-run-${date}.{md,html}`);
}
