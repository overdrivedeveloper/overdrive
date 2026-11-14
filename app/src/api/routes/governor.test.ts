import { afterAll, expect, test } from "bun:test";
import { harness, idOf, WAD } from "../test-support";
import { withinOneUnit } from "./governor";

const NOW = new Date("2026-11-13T15:00:00Z");
const exposure = { deltaUsdWad: 1_000_000n * 10n ** 12n, gammaUsdWad: 500_000n * 10n ** 12n, openValueWad: 2_000_000n * 10n ** 12n }; // delta 1 USDG, gamma 0.5 USDG
const reads = { reserve: 400_000_000n, floor: 100_000_000n };
const h = await harness("governor", {
  now: NOW,
  chain: { governor: {
    equity: async () => 9n * WAD, freeCash: async () => 3_000_000n, stressLoss: async () => ({ lossWad: 2n * WAD, budgetWad: 4n * WAD }), hedgeStale: async () => false,
    buysPaused: async () => ({ paused: false, reason: "" }), exposure: async () => exposure, exitReserve: async () => reads.reserve, exitReserveFloor: async () => reads.floor,
  } },
});
afterAll(async () => { await h?.close(); });

const ledger = async (agoMin: number, delta: bigint, hedge: bigint) => {
  const ts = new Date(NOW.getTime() - agoMin * 60_000).toISOString();
  await h!.raw`INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block) VALUES (${ts}, 'TSLA', ${delta.toString()}, ${(500_000n).toString()}, ${hedge.toString()}, 9, 1, 5) ON CONFLICT DO NOTHING`;
};

test("matches_ledger_getter_and_flags_stale", async () => {
  if (!h) return;
  await h.seedIndexer(60_000);
  await ledger(60, 1_000_000n, 1_000_000n);
  const live = (await (await h.app.request("/v1/governor")).json()) as any;
  const u = live.underlyings.find((x: any) => x.underlying === "TSLA");
  expect(u.delta).toBe("1000000"); // ledger row
  expect(u.chainDelta).toBe("1000000"); // IODGovernor.exposure(market), to the unit
  expect(u.chainGamma).toBe("500000");
  expect(u.matchesChain).toBe(true);
  expect(u.residual).toBe("0");
  expect(u.unhedgedSince).toBeNull();
  expect(live.live).toBe(true);
  expect(live.stale).toBe(false);
  expect(live.exitReserve).toMatchObject({ balanceUsdg: "400000000", floorUsdg: "100000000" });
  expect(live.hedgeEquity.offChain).toBe(true);
  expect(withinOneUnit(5n, 6n)).toBe(true);
  expect(withinOneUnit(5n, 7n)).toBe(false);

  // exit reserve and floor are chain reads cached 30 s: a change on chain is not visible inside the window
  reads.reserve = 1n;
  const cached = (await (await h.app.request("/v1/governor")).json()) as any;
  expect(cached.exitReserve.balanceUsdg).toBe("400000000");
  reads.reserve = 400_000_000n;

  // an unhedged residual older than 15 minutes shows since when
  await ledger(40, 1_000_000n, 0n);
  await ledger(20, 1_000_000n, 0n);
  await ledger(0, 1_000_000n, 400_000n);
  const open = (await (await h.app.request("/v1/governor")).json()) as any;
  const t = open.underlyings.find((x: any) => x.underlying === "TSLA");
  expect(t.residual).toBe("600000");
  expect(t.unhedgedSince).toBe(new Date(NOW.getTime() - 40 * 60_000).toISOString());

  // a snapshot older than 30 minutes is stale and is never live
  await h.seedIndexer(31 * 60_000);
  const stale = (await (await h.app.request("/v1/governor")).json()) as any;
  expect(stale.stale).toBe(true);
  expect(stale.live).toBe(false);
});

test("a risk run older than 36 hours is marked stale and shown with its age", async () => {
  if (!h) return;
  const at = new Date(NOW.getTime() - 37 * 3_600_000).toISOString();
  await h.raw`INSERT INTO service_status (job, last_run, last_ok, meta) VALUES ('risk-sim', ${at}, ${at}, ${JSON.stringify({ worstLossUsdg: "5" })}::jsonb)`;
  const body = (await (await h.app.request("/v1/risk")).json()) as any;
  expect(body.run.stale).toBe(true);
  expect(body.run.ageSec).toBe(37 * 3600);
  expect(body.run.summary.worstLossUsdg).toBe("5");
});
void idOf;
