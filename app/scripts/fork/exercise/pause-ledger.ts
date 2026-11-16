// The pause ledger format of docs/runbooks/upgrades/PAUSE-LEDGER.md as code (tracker 69a): one table row per pause and one
// per unpause schedule, closed with the execute tx. The fork flow L01 writes a copy under FORK_DIR and re-reads it with the
// parser below, so a drift between the runbook columns and what an operator would write is caught here.
export const LEDGER_COLUMNS = ["When (UTC)", "Lever", "Action", "Tx", "Unpause op", "Ready (UTC / owner zone)", "Why", "Closed (tx)"] as const;
export interface LedgerRow { when: string; lever: string; action: string; tx: string; unpauseOp: string; ready: string; why: string; closed: string }

export const LEDGER_HEADER = `| ${LEDGER_COLUMNS.join(" | ")} |\n|${LEDGER_COLUMNS.map(() => "---").join("|")}|`;

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
export function formatRow(r: LedgerRow): string {
  return `| ${[r.when, r.lever, r.action, r.tx, r.unpauseOp, r.ready, r.why, r.closed].map(cell).join(" | ")} |`;
}

/** Table rows of a ledger Markdown text (header and separator skipped). Throws on a row that does not have 8 cells. */
export function parseLedger(md: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let seenHeader = false;
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.slice(1, line.lastIndexOf("|")).split("|").map((c) => c.trim());
    if (!seenHeader) {
      if (cells.join("|") !== LEDGER_COLUMNS.join("|")) throw new Error(`ledger header is not the runbook format: ${cells.join("|")}`);
      seenHeader = true;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (cells.length !== 8) throw new Error(`ledger row has ${cells.length} cells, want 8: ${line}`);
    const [when, lever, action, tx, unpauseOp, ready, why, closed] = cells as [string, string, string, string, string, string, string, string];
    rows.push({ when, lever, action, tx, unpauseOp, ready, why, closed });
  }
  if (!seenHeader) throw new Error("no ledger table found");
  return rows;
}

/** Rule 1 of the ledger: a guardian pause has a scheduled unpause or a written reason. Returns the broken rows. */
export function unpausedWithoutPlan(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter((r) => /pause/i.test(r.action) && !/unpause/i.test(r.action) && !/^0x[0-9a-f]{64}$/i.test(r.unpauseOp) && !r.why.trim());
}

/** UTC stamp as the ledger writes it: 2026-11-16 17:20. */
export const utcStamp = (unix: bigint | number): string => new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace("T", " ");
