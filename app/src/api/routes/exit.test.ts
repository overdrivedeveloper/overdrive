import { afterAll, expect, test } from "bun:test";
import { harness } from "../test-support";
import { canExitNow } from "./exit";

const state = { reserve: 400_000_000n, floor: 100_000_000n };
const h = await harness("exit", { chain: { governor: {
  equity: async () => 0n, freeCash: async () => 0n, stressLoss: async () => ({ lossWad: 0n, budgetWad: 0n }), hedgeStale: async () => false, buysPaused: async () => ({ paused: false, reason: "" }),
  exposure: async () => ({ deltaUsdWad: 0n, gammaUsdWad: 0n, openValueWad: 0n }), exitReserve: async () => state.reserve, exitReserveFloor: async () => state.floor,
} } });
afterAll(async () => { await h?.close(); });

test("can_exit_now_rules", async () => {
  expect(canExitNow(true, { status: "active", session: "OPEN", price: "1" })).toBe(true);
  expect(canExitNow(false, { status: "active", session: "OPEN", price: "1" })).toBe(false); // reserve at or below its floor
  expect(canExitNow(true, { status: "retired", session: "OPEN", price: "1" })).toBe(false);
  expect(canExitNow(true, { status: "active", session: "CLOSED", price: "1" })).toBe(false); // closed: instant only on a fresh Pyth print, which the API cannot see (D35)
  expect(canExitNow(true, { status: "active", session: "HALTED", price: "1" })).toBe(false);
  expect(canExitNow(true, { status: "active", session: "UNKNOWN", price: "1" })).toBe(false);
  expect(canExitNow(true, { status: "active", session: "CLOSED", price: null })).toBe(false); // closed with no last price
  if (!h) return;
  await h.seedIndexer();
  await h.seedGear("TSLA-SPORT", { valueWad: 100n * 10n ** 18n, supply: 5n * 10n ** 18n });
  await h.seedGear("NVDA/TSLA-SPORT", { session: "CLOSED" });
  const ids = h.deployment.gears.slice(0, 2).map((g) => g.id);
  const old = new Date(Date.now() - 3_600_000).toISOString();
  await h.raw`INSERT INTO queued_sells (ticket, gear, account, tokens, min_proceeds, queued_block, queued_at, status) VALUES (1, ${ids[0]!}, '0xabc', 1, 1, 1, ${old}, 'open'), (2, ${ids[0]!}, '0xabc', 1, 1, 1, now(), 'open'), (3, ${ids[0]!}, '0xabc', 1, 1, 1, now(), 'filled')`;
  const body = (await (await h.app.request("/v1/exit")).json()) as any;
  expect(body.aboveFloor).toBe(true);
  expect(body.queue.depth).toBe(2); // open tickets only
  expect(body.queue.oldestAgeSec).toBeGreaterThanOrEqual(3590);
  const open = BigInt(5n * 100n * 1_000_000n); // 5 tokens at 100 USD in USDG
  expect(body.coverageRatioBps).toBe(Number((state.reserve * 10_000n) / open));
  const sport = body.gears.find((g: any) => g.symbol === "TSLA-SPORT");
  const cruise = body.gears.find((g: any) => g.symbol === "NVDA/TSLA-SPORT");
  expect(sport.canExitNow).toBe(true);
  expect(cruise.sellMode).toBe("instant_min");
  expect(cruise.rule).toContain("lower of the last value and the reference value");
  // the reserve at the floor: nothing can exit now
  state.reserve = state.floor;
  h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
  const below = (await (await h.app.request("/v1/exit")).json()) as any;
  expect(below.aboveFloor).toBe(false);
  expect(below.gears.every((g: any) => g.canExitNow === false)).toBe(true);
});
