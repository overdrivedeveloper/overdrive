import { afterAll, expect, test } from "bun:test";
import { harness, mockBook, mockGear, WAD } from "../test-support";
import { MockRevert } from "../../testing/mock-hook";

const h = await harness("fuzz");
afterAll(async () => { await h?.close(); });

// Seeded generator (mulberry32): the same 500 states every run.
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test("buyable_flag_matches_execution", async () => {
  if (!h) return;
  const rand = rng(20261113);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const int = (lo: number, hi: number) => BigInt(lo + Math.floor(rand() * (hi - lo + 1)));
  let buyableCount = 0, refusedCount = 0;
  for (let i = 0; i < 500; i++) {
    const g = pick(h.deployment.gears);
    const id = g.id.toLowerCase();
    const side = pick(["buy", "sell"] as const);
    h.hook.gears.set(id, mockGear(id, {
      valueWad: int(1, 400) * WAD / 2n, lastValueWad: int(1, 400) * WAD / 2n, refValueWad: rand() < 0.2 ? 0n : int(1, 400) * WAD / 2n,
      spreadBps: Number(int(5, 300)), session: Number(pick([0, 0, 0, 1, 2, 3, 4])), fresh: rand() > 0.15, splitPending: rand() < 0.08,
      status: pick(["LISTED", "LISTED", "LISTED", "BUYS_PAUSED", "SELL_ONLY"] as const), capUsdg: int(1, 2000) * 1_000_000n, openUsdg: int(0, 1500) * 1_000_000n,
      minTradeUsdg: int(0, 20) * 100_000n,
    }));
    Object.assign(h.hook.book, mockBook({ reserveUsdg: int(0, 500) * 1_000_000n, floorUsdg: int(0, 400) * 1_000_000n, freeCashUsdg: int(0, 500) * 1_000_000n }));
    const amount = side === "buy" ? int(500_000, 1_500_000_000) : int(1, 40) * WAD;
    const res = await h.app.request(`/v1/quote?gear=${g.symbol}&side=${side}&${side === "buy" ? "usdg" : "tokens"}=${amount}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    let executed: { amountOut: bigint } | null = null;
    try { executed = h.hook.execute({ gear: id, side, exactIn: amount }); } catch (e) { expect(e).toBeInstanceOf(MockRevert); }
    if (body.buyable) { buyableCount++; expect(executed?.amountOut.toString()).toBe(body.amountOut); }
    else { refusedCount++; expect(executed).toBeNull(); }
  }
  expect(buyableCount).toBeGreaterThan(50);
  expect(refusedCount).toBeGreaterThan(50);
});
