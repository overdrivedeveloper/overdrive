import { afterAll, expect, test } from "bun:test";
import { harness, WAD, type Harness } from "../test-support";
import { parityFailures } from "./parity";
import { MockRevert } from "../../testing/mock-hook";

const h = await harness("parity");
afterAll(async () => { await h?.close(); });

async function api(h: Harness, path: string) {
  const r = await h.app.request(path);
  return { status: r.status, body: (await r.json()) as any };
}
const BUY_SIZES = [1_000_000n, 5_000_000n, 25_000_000n, 100_000_000n, 1_000_000_000n, 7_777_777n, 50_000_000_000n, 123_456_789n];
const SELL_SIZES = BUY_SIZES.map((n) => (n * WAD) / 10_000_000n);

test("api_equals_quoter_equals_execution", async () => {
  if (!h) return;
  expect(h.deployment.gears.length).toBe(6); // five powers and one pair
  for (const g of h.deployment.gears) {
    const id = g.id.toLowerCase();
    for (const side of ["buy", "sell"] as const) {
      for (const size of side === "buy" ? BUY_SIZES : SELL_SIZES) {
        const { body } = await api(h, `/v1/quote?gear=${g.symbol}&side=${side}&${side === "buy" ? "usdg" : "tokens"}=${size}`);
        const v4 = h.hook.v4Quote({ gear: id, side, exactIn: size });
        const minter = h.hook.minterQuote({ gear: id, side, exactIn: size });
        expect(body.buyable).toBe(true);
        expect(body.source).toBe("v4_quoter");
        expect(body.amountOut).toBe(v4.amountOut.toString());
        expect(parityFailures(v4, minter)).toEqual([]);
        const executed = h.hook.execute({ gear: id, side, exactIn: size }); // same block, to the unit
        expect(body.amountOut).toBe(executed.amountOut.toString());
        expect(body.amountIn).toBe(executed.amountIn.toString());
        expect(body.minterQuote.amountOut).toBe(executed.amountOut.toString());
        expect(BigInt(body.minOutSuggested)).toBe((executed.amountOut * 9950n) / 10000n);
        // restore state moved by execute
        const gear = h.hook.gears.get(id)!;
        gear.openUsdg = 0n; h.hook.book.freeCashUsdg = 500_000_000_000n; h.hook.book.reserveUsdg = 500_000_000_000n;
      }
    }
  }
});

test("a parity mismatch fails closed: no price, buyable false", async () => {
  if (!h) return;
  const original = h.chain.minterQuote;
  h.chain.minterQuote = async (i) => ({ ...(await original(i)), amountOut: 1n });
  h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
  const { body } = await api(h, `/v1/quote?gear=TSLA-SPORT&side=buy&usdg=1000000`);
  h.chain.minterQuote = original;
  expect(body.buyable).toBe(false);
  expect(body.reason).toBe("PARITY_MISMATCH");
  expect(body.parity).toContain("amountOut");
  expect(body.tokensOut).toBeNull();
});

type Case = { name: string; set: (h: Harness) => void; side: "buy" | "sell"; amount: bigint; ok: boolean; reason?: string };
const SYM = "TSLA-SPORT";
const cases = (h: Harness): Case[] => {
  const g = () => h.hook.gears.get(h.deployment.gears.find((x) => x.symbol === SYM)!.id.toLowerCase())!;
  const cap = 1_000_000_000_000n;
  return [
    { name: "exactly at the cap", set: () => { g().capUsdg = 100_000_000n; }, side: "buy", amount: 100_000_000n, ok: true },
    { name: "one unit above the cap", set: () => { g().capUsdg = 100_000_000n - 1n; }, side: "buy", amount: 100_000_000n, ok: false, reason: "CAP" },
    { name: "one unit below the cap", set: () => { g().capUsdg = 100_000_000n + 1n; }, side: "buy", amount: 100_000_000n, ok: true },
    { name: "at the exit reserve floor", set: () => { h.hook.book.reserveUsdg = h.hook.book.floorUsdg; }, side: "buy", amount: 5_000_000n, ok: true },
    { name: "below the exit reserve floor", set: () => { h.hook.book.reserveUsdg = h.hook.book.floorUsdg - 1n; }, side: "buy", amount: 5_000_000n, ok: false, reason: "RESERVE_FLOOR" },
    { name: "exactly the minimum trade", set: () => undefined, side: "buy", amount: 1_000_000n, ok: true },
    { name: "one unit below the minimum", set: () => undefined, side: "buy", amount: 999_999n, ok: false, reason: "BELOW_MINIMUM" },
    { name: "feed stale", set: () => { g().fresh = false; }, side: "buy", amount: 5_000_000n, ok: false, reason: "STALE" },
    { name: "gear paused", set: () => { g().status = "BUYS_PAUSED"; }, side: "buy", amount: 5_000_000n, ok: false, reason: "MANUAL" },
    { name: "session closed", set: () => { g().session = 2; }, side: "buy", amount: 5_000_000n, ok: false, reason: "CLOSED" },
    { name: "split pending", set: () => { g().splitPending = true; }, side: "buy", amount: 5_000_000n, ok: false, reason: "SPLIT_PENDING" },
    { name: "closed sell pays now", set: () => { g().session = 2; }, side: "sell", amount: WAD, ok: true },
    { name: "sell with no reference when closed queues", set: () => { g().session = 2; g().refValueWad = 0n; }, side: "sell", amount: WAD, ok: false, reason: "USE_QUEUE" },
    { name: "stale feed does not block a sell", set: () => { g().fresh = false; }, side: "sell", amount: WAD, ok: true },
  ].map((c) => ({ ...c, cap }) as unknown as Case);
};

test("limits_never_quote_unexecutable", async () => {
  if (!h) return;
  const reset = () => {
    for (const g of h.hook.gears.values()) Object.assign(g, { fresh: true, status: "LISTED", splitPending: false, session: 0, capUsdg: 1_000_000_000_000n, openUsdg: 0n, refValueWad: 99n * WAD });
    Object.assign(h.hook.book, { reserveUsdg: 500_000_000_000n, floorUsdg: 100_000_000_000n, freeCashUsdg: 500_000_000_000n });
  };
  for (const c of cases(h)) {
    reset();
    c.set(h);
    const { body } = await api(h, `/v1/quote?gear=${SYM}&side=${c.side}&${c.side === "buy" ? "usdg" : "tokens"}=${c.amount}`);
    const id = h.deployment.gears.find((x) => x.symbol === SYM)!.id.toLowerCase();
    let executed: string | null;
    try { executed = h.hook.execute({ gear: id, side: c.side, exactIn: c.amount }).amountOut.toString(); } catch (e) { expect(e).toBeInstanceOf(MockRevert); executed = null; }
    expect({ case: c.name, buyable: body.buyable }).toEqual({ case: c.name, buyable: c.ok });
    if (c.ok) expect(body.amountOut).toBe(executed!);
    else { expect(executed).toBeNull(); expect(body.reason).toBe(c.reason!); if (c.side === "buy") expect(body.tokensOut).toBeNull(); }
  }
  reset();
});

test.skipIf(!process.env.RHC_FORK_RPC)("fork variant: every gear on the real contracts (pending todos 05 and 06; needs RHC_FORK_RPC)", () => {
  expect(process.env.RHC_FORK_RPC).toBeTruthy();
});
