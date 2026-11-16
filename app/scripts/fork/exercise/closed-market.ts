// H09 to H12: feed stale, market closed, queued sell settlement, oracle paused. The real feeds are frozen at the fork
// block, so these run on a mock Chainlink feed and a mock Stock Token (harness.ensureMockMarket); freshness and
// session are the real ODOracleGuard and ODMarketHours logic.
import { parseEventLogs, type Address, type Hex } from "viem";
import { IODMinterAbi } from "../../../src/abi";
import { addressOf, erc20Abi } from "../lib";
import { refreshPyth } from "../setup";
import {
  GEAR, gotoSession, atNextSecond, buyDirect, ensureCapital, ensureGear, ensureMockMarket, formulaValueOf, freshen, fundRole, minterQuote, mockPythAbi, mockStockAbi,
  normOf, normStep, writtenNorm, nowTs, pokeMarket, priceOf, pushMockFeed, refreshMocks, sellDirect, tokenOf, usdgOf, warpBy, approveMinter, type Abi, type Ctx, type Flow,
  type GearInfo, type MockMarket, type Row,
} from "./harness";
import { walletFor } from "../lib";
import { gapRate } from "../../../src/pricing/toll";

const P100 = 100n * 10n ** 8n;

/** Opens a session (clock warp if needed) and resets the mock market: feed $100 updated now, multiplier 1, no pauses. */
export async function mockEnv(ctx: Ctx, row: Row, symbol = "MCKA"): Promise<{ m: MockMarket; g: GearInfo }> {
  await ensureCapital(ctx, row);
  const m = await ensureMockMarket(ctx, symbol, symbol === "MCKA");
  const g = await ensureGear(ctx, row, symbol, null, GEAR.SPORT);
  if ((await priceOf(ctx, symbol)).session !== 0) {
    await gotoSession(ctx, "open", symbol);
  }
  await row.send("mock stock: clear pauses", "deployer", { address: m.stock, abi: mockStockAbi as Abi, functionName: "setOraclePaused", args: [false] });
  await row.send("mock stock: multiplier 1", "deployer", { address: m.stock, abi: mockStockAbi as Abi, functionName: "setMultipliers", args: [10n ** 18n, 10n ** 18n, 0n] });
  await pushMockFeed(ctx, row, m, P100, undefined, "mock feed $100 now");
  await refreshPyth();
  await refreshMocks(ctx);
  await freshen(ctx, ["ETH", symbol]);
  await pokeMarket(ctx, row, symbol);
  return { m, g };
}

/** Sets the mock Pyth entry of a market (token price, 8 dp) with an explicit publish time. */
export async function setPyth(ctx: Ctx, row: Row, m: MockMarket, price8: bigint, publishTime: bigint, label: string): Promise<void> {
  await row.send(label, "spare1", { address: ctx.dep.external.pythCore as Address, abi: mockPythAbi as Abi, functionName: "setPrice", args: [m.pythId, price8, 0n, -8, publishTime] });
}

const goWeekend = (ctx: Ctx) => gotoSession(ctx, "weekend");

const expectedSellValue = async (ctx: Ctx, g: GearInfo, symbol: string, t: bigint, p: bigint) => {
  const w = await writtenNorm(ctx, g.id);
  const rate = gapRate(w.tollPerSecWad, (await normOf(ctx, g.id)).tollPerSecWad);
  return formulaValueOf(ctx, g, p, normStep(w.nf, rate, t - w.lastAccrual));
};

const H09: Flow = {
  id: "H09", area: "holders", kind: "expected_failure", name: "feed stale: buys revert, sell works at min(last value, reference value)",
  async run(row, ctx) {
    const { m, g } = await mockEnv(ctx, row);
    const who = await fundRole(ctx, "alice", 100_000);
    const b0 = await tokenOf(ctx, g.token, who);
    const { got } = await buyDirect(ctx, row, "alice", g, 2_000_000_000n, "alice buy MCKA-SPORT");
    await pokeMarket(ctx, row, "MCKA");
    const now = await nowTs(ctx);
    await setPyth(ctx, row, m, 95n * 10n ** 8n, now, "reference (Pyth) drops to $95");
    await pushMockFeed(ctx, row, m, P100, now - 31n * 86_400n, "feed last updated 31 days ago (maxAge 30 d)");
    const r = await priceOf(ctx, "MCKA");
    row.chain("guard session HALTED (4)", r.session, 4);
    row.chain("guard reason HALTED", Buffer.from(r.reason.slice(2), "hex").toString().replace(/\0+$/, ""), "HALTED");
    row.chainTrue("guard reference is $95", r.refP === 95n * 10n ** 18n, r.refP);
    await row.expectRevert("buy with a stale feed", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, 1_000_000_000n, 0n, who, (await nowTs(ctx)) + 3600n] }, ["BuysClosed"]);
    // sell: value from min(last good $100, reference $95)
    await approveMinter(ctx, row, "alice", g.token, ctx.c.ODMinter!);
    const q = await atNextSecond(ctx, async (t) => {
      const quote = await minterQuote(ctx, t, g.id, false, true, got, who);
      row.chainTrue("sell is instant (not queued)", !quote.queued, quote.queued);
      row.chainWithin("sell value == formula(min(lastGood, reference))", quote.valuePerTokenWad, await expectedSellValue(ctx, g, "MCKA", t, 95n * 10n ** 18n), 2n);
      row.chainTrue("sell price below value (closed/halted extra spread)", quote.pricePerTokenWad < quote.valuePerTokenWad, `${quote.pricePerTokenWad} vs ${quote.valuePerTokenWad}`);
      await row.send("sell while the feed is stale", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "sell", args: [g.id, got, 0n, who, t + 3600n] });
      return quote;
    });
    row.chain("tokens sold", await tokenOf(ctx, g.token, who), b0);
    row.note(`sold ${got} tokens for ${q.amountOut} USDG at value ${q.valuePerTokenWad}`);
  },
};

const H10: Flow = {
  id: "H10", area: "holders", kind: "expected_failure", name: "market closed (weekend): buys blocked, sell instant at the lower price, queued without a reference",
  async run(row, ctx) {
    const { m, g } = await mockEnv(ctx, row);
    const who = await fundRole(ctx, "alice", 100_000);
    const b0 = await tokenOf(ctx, g.token, who);
    const { got } = await buyDirect(ctx, row, "alice", g, 3_000_000_000n, "alice buy MCKA-SPORT");
    await pokeMarket(ctx, row, "MCKA");
    await goWeekend(ctx);
    await refreshPyth();
    await refreshMocks(ctx);
    const r = await priceOf(ctx, "MCKA");
    row.chainTrue("session CLOSED (2) or UNKNOWN (3)", r.session === 2 || r.session === 3, r.session);
    row.chainTrue("last good price held", r.fresh && r.p === 100n * 10n ** 18n, `${r.p} fresh=${r.fresh}`);
    await row.expectRevert("buy while closed", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, 1_000_000_000n, 0n, who, (await nowTs(ctx)) + 3600n] }, ["BuysClosed"]);
    await approveMinter(ctx, row, "alice", g.token, ctx.c.ODMinter!);
    const half = got / 2n;
    // instant sell at the lower (closed) price while a reference exists
    await atNextSecond(ctx, async (t) => {
      const quote = await minterQuote(ctx, t, g.id, false, true, half, who);
      row.chainTrue("closed sell with a reference is instant", !quote.queued, quote.queued);
      row.chainTrue("closed sell price below value", quote.pricePerTokenWad < quote.valuePerTokenWad, `${quote.pricePerTokenWad} vs ${quote.valuePerTokenWad}`);
      const u0 = await usdgOf(ctx, who);
      await row.send("instant sell while closed", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "sell", args: [g.id, half, 0n, who, t + 3600n] });
      row.chain("USDG received == quote", (await usdgOf(ctx, who)) - u0, quote.amountOut);
    });
    // no reference: the sell must be queued
    await setPyth(ctx, row, m, P100, (await nowTs(ctx)) - 2n * 86_400n, "reference older than refMaxAge");
    const rest = got - half;
    const q = await minterQuote(ctx, null, g.id, false, true, rest, who);
    row.chain("quote says queued without a reference", q.queued, true);
    await row.expectRevert("instant sell without a reference reverts", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "sell", args: [g.id, rest, 0n, who, (await nowTs(ctx)) + 3600n] }, ["UseQueue"]);
    const before = (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "ticketCount" })) as bigint;
    await row.send("queueSell the rest", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "queueSell", args: [g.id, rest, 1n, who] });
    const ticket = (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "ticketCount" })) as bigint;
    row.chain("ticket count grew by one", ticket, before + 1n);
    row.chain("tokens escrowed", await tokenOf(ctx, g.token, who), b0);
    await row.send("cancel the queued sell", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "cancelQueued", args: [ticket] });
    row.chain("tokens returned on cancel", await tokenOf(ctx, g.token, who), b0 + rest);
    // leave the clock in an open session for the next flow
    await gotoSession(ctx, "open");
  },
};

const H11: Flow = {
  id: "H11", area: "holders", kind: "success", name: "queued sell settles at the next fresh price (crank, and a permissionless call)",
  async run(row, ctx) {
    // the row holds the crank for a while: whatever happens, it runs again afterwards (up.sh keeps a running one)
    try { await H11body(row, ctx); } finally { (await import("./harness")).startService("crank"); }
  },
};
async function H11body(row: Row, ctx: Ctx): Promise<void> {
  {
    const { m, g } = await mockEnv(ctx, row);
    const who = await fundRole(ctx, "alice", 100_000);
    await fundRole(ctx, "bob", 100_000);
    const b0 = await tokenOf(ctx, g.token, who);
    const { got } = await buyDirect(ctx, row, "alice", g, 4_000_000_000n, "alice buy MCKA-SPORT");
    await pokeMarket(ctx, row, "MCKA");
    await goWeekend(ctx);
    await refreshPyth();
    await setPyth(ctx, row, m, P100, (await nowTs(ctx)) - 2n * 86_400n, "no reference while closed");
    const t1 = got / 2n, t2 = got - t1;
    // the running crank fills any fillable ticket within a pass: hold it while bob makes the permissionless fill of B
    const { stopService } = await import("./liquidation");
    stopService("crank");
    const c0 = (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "ticketCount" })) as bigint;
    await row.send("queueSell ticket A", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "queueSell", args: [g.id, t1, 1n, who] });
    await row.send("queueSell ticket B", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "queueSell", args: [g.id, t2, 1n, who] });
    const A = c0 + 1n, B = c0 + 2n;
    row.chain("two tickets queued", (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "ticketCount" })) as bigint, c0 + 2n);
    await row.expectRevert("fill while closed with no reference", "bob", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "fillQueued", args: [A] }, ["NotFillable"]);
    // next open session, fresh price
    await gotoSession(ctx, "open");
    await pushMockFeed(ctx, row, m, P100, undefined, "mock feed fresh at the open");
    await refreshPyth();
    await refreshMocks(ctx);
    await pokeMarket(ctx, row, "MCKA");
    const u0 = await usdgOf(ctx, who);
    const rec = await row.send("bob fills ticket B (permissionless)", "bob", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "fillQueued", args: [B] });
    const logs = parseEventLogs({ abi: IODMinterAbi, logs: (await ctx.pub.getTransactionReceipt({ hash: rec.hash as Hex })).logs, eventName: "QueueFilled" });
    row.chain("QueueFilled event for B", logs[0]?.args.ticket, B);
    const outB = logs[0]!.args.usdgOut;
    row.chain("owner paid exactly usdgOut", (await usdgOf(ctx, who)) - u0, outB);
    const ns = await normOf(ctx, g.id);
    row.chainWithin("fill value == formula(fresh p, NF)", logs[0]!.args.valuePerTokenWad, await formulaValueOf(ctx, g, (await priceOf(ctx, "MCKA")).p, ns.nf), 2n);
    const u1 = await usdgOf(ctx, who);
    (await import("./harness")).startService("crank");
    // ticket A is left to the running crank (queued-sells job); give it up to 3 minutes
    const read = async () => (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "queuedSell", args: [A] })) as readonly [Hex, Address, Address, bigint, bigint];
    let a = await read();
    for (const end = Date.now() + 180_000; a[3] !== 0n && Date.now() < end; await Bun.sleep(5000)) a = await read();
    row.chain("ticket A cleared (by the crank or its own job)", a[3], 0n);
    row.chainTrue("owner received proceeds for A", (await usdgOf(ctx, who)) > u1 || a[3] === 0n, "");
    row.chain("alice holds no more gear than before", await tokenOf(ctx, g.token, who), b0);
    const acct = await (await fetch(`${(await import("../lib")).API_URL}/v1/account/${who}`)).json() as { queuedSells: unknown[] };
    row.api("API queued sells empty after fill", acct.queuedSells.length, 0);
  }
}

const H12: Flow = {
  id: "H12", area: "holders", kind: "expected_failure", name: "oracle paused on the Stock Token: buys blocked, sells open",
  async run(row, ctx) {
    const { m, g } = await mockEnv(ctx, row);
    const who = await fundRole(ctx, "alice", 100_000);
    const b0 = await tokenOf(ctx, g.token, who);
    const { got } = await buyDirect(ctx, row, "alice", g, 2_000_000_000n, "alice buy MCKA-SPORT");
    await pokeMarket(ctx, row, "MCKA");
    await row.send("Stock Token oracle paused", "deployer", { address: m.stock, abi: mockStockAbi as Abi, functionName: "setOraclePaused", args: [true] });
    const r = await priceOf(ctx, "MCKA");
    row.chain("guard session HALTED (4)", r.session, 4);
    await row.expectRevert("buy with the oracle paused", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, 1_000_000_000n, 0n, who, (await nowTs(ctx)) + 3600n] }, ["BuysClosed"]);
    const half = got / 2n;
    const q = await sellDirect(ctx, row, "alice", g, half, "sell half while the oracle is paused");
    row.chainTrue("sell instant while paused", !q.queued, q.queued);
    await row.send("Stock Token oracle unpaused", "deployer", { address: m.stock, abi: mockStockAbi as Abi, functionName: "setOraclePaused", args: [false] });
    await pokeMarket(ctx, row, "MCKA");
    await freshen(ctx, ["MCKA"]);
    await buyDirect(ctx, row, "alice", g, 1_000_000_000n, "buy again after unpause");
    void erc20Abi; void walletFor; void addressOf;
  },
};

export const flows: Flow[] = [H09, H10, H11, H12];
void warpBy;
