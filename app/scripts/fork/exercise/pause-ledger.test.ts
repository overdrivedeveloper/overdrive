import { describe, expect, test } from "bun:test";
import { LEDGER_HEADER, formatRow, parseLedger, unpausedWithoutPlan, utcStamp, type LedgerRow } from "./pause-ledger";

const pauseRow: LedgerRow = { when: "2026-11-16 17:20", lever: "ODGovernor buys", action: "guardian pause", tx: "0x" + "ab".repeat(32), unpauseOp: "0x" + "cd".repeat(32), ready: "2026-11-18 17:20 / 12:20 ET", why: "test", closed: "" };

describe("pause ledger format", () => {
  test("a row round-trips through the runbook table", () => {
    const md = `# Pause ledger\n\n${LEDGER_HEADER}\n| (deploy) | ODBacker mint | deployed paused (D10, closed) | deploy tx | scheduled at backer launch | n/a | backers deploy closed | |\n${formatRow(pauseRow)}\n\nRules:\n1. x\n`;
    const rows = parseLedger(md);
    expect(rows.length).toBe(2);
    expect(rows[1]).toEqual(pauseRow);
  });
  test("a wrong header or a short row is refused", () => {
    expect(() => parseLedger("| a | b |\n|---|---|\n")).toThrow("not the runbook format");
    expect(() => parseLedger(`${LEDGER_HEADER}\n| a | b |\n`)).toThrow("want 8");
    expect(() => parseLedger("nothing here")).toThrow("no ledger table");
  });
  test("rule 1: a pause with neither an unpause op nor a reason is flagged", () => {
    expect(unpausedWithoutPlan([pauseRow])).toEqual([]);
    expect(unpausedWithoutPlan([{ ...pauseRow, unpauseOp: "", why: "" }]).length).toBe(1);
  });
  test("pipes and newlines in a cell cannot break the table", () => {
    expect(formatRow({ ...pauseRow, why: "a | b\nc" })).toContain("a / b c");
  });
  test("utcStamp", () => { expect(utcStamp(1_794_849_600n)).toBe("2026-11-16 17:20"); });
});
