import { describe, expect, test } from "bun:test";
import { MAX_HORIZON_SECONDS, MAX_SESSION_SECONDS, MAX_SESSIONS, computeSessions, etInstant, mergeWindows, nextBoundaries } from "./sessions";

const at = (iso: string) => new Date(iso);
const sec = (iso: string) => BigInt(Date.parse(iso) / 1000);
const kinds = (list: ReturnType<typeof computeSessions>) => list.map((s) => `${s.kind}:${new Date(Number(s.open) * 1000).toISOString()}>${new Date(Number(s.close) * 1000).toISOString()}`);

describe("sessions", () => {
  test("nyse_2026_2028_known_days", () => {
    // 2026-11-26 Thanksgiving closed; 11-27 early close at 13:00 ET (18:00Z); 12-24 early close; 12-25 closed
    const nov = computeSessions(at("2026-11-23T15:00:00Z"), "us_equity");
    const regular = nov.filter((s) => s.kind === "regular").map((s) => new Date(Number(s.open) * 1000).toISOString().slice(0, 10));
    expect(regular).not.toContain("2026-11-26");
    expect(regular).toContain("2026-11-25");
    expect(regular).toContain("2026-11-27");
    const friday = nov.find((s) => s.kind === "regular" && new Date(Number(s.open) * 1000).toISOString().startsWith("2026-11-27"))!;
    expect(new Date(Number(friday.close) * 1000).toISOString()).toBe("2026-11-27T18:00:00.000Z");
    const dec = computeSessions(at("2026-12-21T15:00:00Z"), "us_equity");
    const eve = dec.find((s) => s.kind === "regular" && new Date(Number(s.open) * 1000).toISOString().startsWith("2026-12-24"))!;
    expect(new Date(Number(eve.close) * 1000).toISOString()).toBe("2026-12-24T18:00:00.000Z");
    expect(dec.filter((s) => s.kind === "regular").map((s) => new Date(Number(s.open) * 1000).toISOString().slice(0, 10))).not.toContain("2026-12-25");
    // 2027: Good Friday 03-26, observed Juneteenth 06-18, observed Christmas 12-24, no closure on 12-31 2027 for the 2028 New Year
    const cases: [string, string][] = [["2027-03-22T15:00:00Z", "2027-03-26"], ["2027-06-14T15:00:00Z", "2027-06-18"], ["2027-12-20T15:00:00Z", "2027-12-24"], ["2028-04-10T15:00:00Z", "2028-04-14"], ["2028-11-20T15:00:00Z", "2028-11-23"]];
    for (const [now, closed] of cases) {
      const days = computeSessions(at(now), "us_equity").filter((s) => s.kind === "regular").map((s) => new Date(Number(s.open) * 1000).toISOString().slice(0, 10));
      expect(days).not.toContain(closed);
      expect(days.length).toBeGreaterThan(10);
    }
    const dec2027 = computeSessions(at("2027-12-27T15:00:00Z"), "us_equity").filter((s) => s.kind === "regular").map((s) => new Date(Number(s.open) * 1000).toISOString().slice(0, 10));
    expect(dec2027).toContain("2027-12-31");
    // outside the calendar the job refuses instead of guessing
    expect(() => computeSessions(at("2029-06-01T15:00:00Z"), "us_equity")).toThrow("needs updating");
  });

  test("dst_boundaries", () => {
    // spring forward 2026-03-08, fall back 2026-11-01: 09:30 ET is 13:30Z in EDT and 14:30Z in EST
    expect(etInstant(Date.UTC(2026, 2, 6), 9 * 60 + 30)).toBe(sec("2026-03-06T14:30:00Z"));
    expect(etInstant(Date.UTC(2026, 2, 9), 9 * 60 + 30)).toBe(sec("2026-03-09T13:30:00Z"));
    expect(etInstant(Date.UTC(2026, 10, 2), 9 * 60 + 30)).toBe(sec("2026-11-02T14:30:00Z"));
    // the overnight stretch that starts Sunday 20:00 ET on the night DST begins is 23 h shorter in UTC terms but still one session
    const week = computeSessions(at("2026-03-05T12:00:00Z"), "us_equity");
    const monday = week.find((s) => s.kind === "extended" && s.close === sec("2026-03-09T13:30:00Z"))!;
    expect(monday.open).toBe(sec("2026-03-09T00:00:00Z"));
    // every regular session is 6.5 h or 3.5 h long whatever the offset
    for (const s of computeSessions(at("2026-10-26T12:00:00Z"), "us_equity")) if (s.kind === "regular") expect([23_400n, 12_600n]).toContain(s.close - s.open);
  });

  test("pushed_list_respects_contract_limits", () => {
    for (const now of ["2026-11-13T15:00:00Z", "2026-12-18T01:00:00Z", "2027-07-01T15:00:00Z", "2028-02-18T12:00:00Z"]) {
      const list = computeSessions(at(now), "us_equity");
      const nowS = BigInt(Date.parse(now) / 1000);
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(MAX_SESSIONS);
      list.forEach((s, i) => {
        expect(s.close).toBeGreaterThan(s.open);
        expect(s.close - s.open).toBeLessThanOrEqual(MAX_SESSION_SECONDS);
        expect(s.close).toBeLessThanOrEqual(nowS + MAX_HORIZON_SECONDS);
        if (i > 0) expect(s.open).toBeGreaterThanOrEqual(list[i - 1]!.close);
      });
      expect(list[0]!.close).toBeGreaterThan(nowS);
    }
  });

  test("crypto_gets_no_windows", () => {
    const [only, ...rest] = computeSessions(at("2026-11-13T15:00:00Z"), "crypto");
    expect(rest).toEqual([]);
    expect(only!.kind).toBe("always_on");
    expect(nextBoundaries([only!], at("2026-11-13T15:00:00Z"))).toEqual([]);
  });

  test("merge_and_boundaries", () => {
    const list = computeSessions(at("2026-11-16T12:00:00Z"), "us_equity");
    const windows = mergeWindows(list);
    // one 24/5 window per week: Sunday 20:00 ET to Friday 20:00 ET
    expect(windows[0]!.close).toBe(sec("2026-11-21T01:00:00Z"));
    const next = nextBoundaries(list, at("2026-11-16T12:00:00Z"));
    expect(next[0]!.kind).toBe("close");
    expect(next[0]!.at.toISOString()).toBe("2026-11-21T01:00:00.000Z");
    expect(kinds(list).length).toBe(list.length);
  });
});

// ---------------------------------------------------------------------------------------------------- the job (mock chain)
import { beforeEach as beforeEachJob } from "bun:test";
import { FakeChain, MARKET_ETH, MARKET_TSLA, nullSql } from "../testing/mock-chain";
import { resetAlertMemory, setAlertSender, type Alert } from "./alerts";
import { createSessionsJob, expectedUplift } from "./jobs/sessions";

describe("sessions job", () => {
  let chain: FakeChain;
  const alerts: Alert[] = [];
  beforeEachJob(() => {
    chain = new FakeChain();
    chain.nowSeconds = BigInt(Date.parse("2026-11-13T15:00:00Z") / 1000);
    alerts.length = 0;
    resetAlertMemory();
    setAlertSender(async (a) => { alerts.push(a); });
  });

  test("pushed_list_goes_through_the_contract_limits", async () => {
    const result = await createSessionsJob(chain.context(nullSql))();
    expect(result.calendarUpdateNeeded).toBe(true);
    // the mock enforces the limits (64 sessions, under 7 days, 30 days ahead, sorted, no overlap) and would have reverted
    expect(chain.sessions.length).toBeGreaterThan(10);
    expect(chain.sessions.length).toBeLessThanOrEqual(64);
    expect(chain.kinds.every((k) => k === 0 || k === 1)).toBe(true);
    // a second run pushes nothing: the horizon is far away and the covered part is the same
    chain.sent.length = 0;
    chain.warp(3600);
    const again = await createSessionsJob(chain.context(nullSql))();
    expect(again.calendarUpdateNeeded).toBe(false);
    expect(chain.sent.length).toBe(0);
    // under 7 days left: pushes again
    chain.warp(24 * 86_400);
    const refreshed = await createSessionsJob(chain.context(nullSql))();
    expect(refreshed.calendarUpdateNeeded).toBe(true);
    expect(alerts.map((a) => a.key)).not.toContain("sessions_horizon_low");
  });

  test("alerts_when_horizon_is_close", async () => {
    const ctx = chain.context(nullSql);
    ctx.tx = { ...ctx.tx, submit: async () => { throw new Error("held"); } } as never;
    chain.sessions = [{ open: chain.nowSeconds - 100n, close: chain.nowSeconds + 86_400n }];
    chain.kinds = [0];
    await expect(createSessionsJob(ctx)()).rejects.toThrow();
    expect(alerts.map((a) => a.key)).toContain("sessions_horizon_low");
  });

  test("crypto_only_deployment_pushes_nothing", async () => {
    chain.deployment = { ...chain.deployment, markets: chain.deployment.markets.filter((m) => m.alwaysOpen) };
    const result = await createSessionsJob(chain.context(nullSql))();
    expect(result.noSessionMarkets).toBe(true);
    expect(chain.sent.length).toBe(0);
  });

  test("friday_uplift_asserted", async () => {
    const run = async (isoNow: string, active: boolean) => {
      chain.nowSeconds = BigInt(Date.parse(isoNow) / 1000);
      chain.sessions = []; chain.kinds = [];
      chain.uplift.set(MARKET_TSLA, active);
      resetAlertMemory();
      alerts.length = 0;
      await createSessionsJob(chain.context(nullSql))();
      return alerts.map((a) => a.key);
    };
    // the 24/5 week closes Friday 20:00 ET (2026-11-21T01:00Z); the lead is 2 h
    expect(await run("2026-11-20T23:30:00Z", false)).toContain("weekend_uplift_missing:TSLA");   // 18:30 ET, inside the lead
    expect(await run("2026-11-20T23:30:00Z", true)).not.toContain("weekend_uplift_missing:TSLA");
    expect(await run("2026-11-18T15:00:00Z", false)).toEqual([]);                                // Wednesday: off is right
    expect(await run("2026-11-18T15:00:00Z", true)).toContain("weekend_uplift_still_on:TSLA");   // on while open: wrong
    // Monday after the reopen at Sunday 20:00 ET it must be off again
    expect(await run("2026-11-23T15:00:00Z", true)).toContain("weekend_uplift_still_on:TSLA");
    expect(await run("2026-11-23T15:00:00Z", false)).toEqual([]);
    expect(expectedUplift([{ open: 0n, close: 100_000n }, { open: 200_000n, close: 300_000n }], 95_000n)).toBe(true);
    void MARKET_ETH;
  });
});
