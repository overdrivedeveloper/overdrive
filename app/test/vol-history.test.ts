import { expect, test } from "bun:test";
import { earningsMoves, parseEdgarReports, weekendGaps } from "../src/seed/vol-history";
import weekend from "../src/config/vol-weekend.json";
import moves from "../src/config/vol-moves.json";
import overrides from "../src/config/earnings-overrides.json";

test("weekendGaps counts only a Friday followed directly by the next Monday", () => {
  const bars = [
    { date: "2026-11-06", open: 100, close: 100 },
    { date: "2026-11-09", open: 102, close: 101 },
    { date: "2026-11-13", open: 101, close: 100 },
    { date: "2026-11-17", open: 90, close: 90 }, // a four-day gap: not a plain weekend
  ];
  expect(weekendGaps(bars)).toEqual([0.02]);
});

test("earningsMoves reads the reaction session from the release time", () => {
  const bars = [
    { date: "2026-11-18", open: 100, close: 100 },
    { date: "2026-11-19", open: 100, close: 100 },
    { date: "2026-11-20", open: 110, close: 110 },
  ];
  expect(earningsMoves(bars, [{ date: "2026-11-19", minute: 17 * 60 }])).toEqual([0.1]); // after the close: next session
  expect(earningsMoves(bars, [{ date: "2026-11-20", minute: 7 * 60 }])).toEqual([0.1]); // before the open: same session
});

test("parseEdgarReports keeps item 2.02 releases and collapses a delivery filing three weeks earlier", () => {
  const payload = {
    filings: { recent: {
      form: ["8-K", "8-K", "10-Q"], items: ["2.02,9.01", "2.02", ""],
      acceptanceDateTime: ["2026-10-02T12:00:00.000Z", "2026-10-22T21:00:00.000Z", "2026-10-23T21:00:00.000Z"],
    } },
  };
  expect(parseEdgarReports(payload).map((r) => r.date)).toEqual(["2026-10-22"]);
});

test("config files parse as objects and the history seeds hold only numbers", () => {
  for (const file of [weekend, moves] as Record<string, unknown>[]) {
    for (const v of Object.values(file)) expect(Array.isArray(v) && v.every((x) => typeof x === "number")).toBe(true);
  }
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) if (!k.startsWith("_")) expect(Array.isArray(v)).toBe(true);
});
