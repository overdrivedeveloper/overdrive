// H13: split day through the mock Stock Token multiplier change, for both feed kinds (multiplier embedded in the feed, and
// multiplied by the guard). Value per token must be unchanged before and after; buys pause from 24 h before the switch
// until 1 h after (ODOracleGuard SPLIT_PENDING).
import { IODMinterAbi } from "../../../src/abi";
import { addressOf } from "../lib";
import { mockEnv, setPyth } from "./closed-market";
import {
  atNextSecond, buyDirect, formulaValueOf, fundRole, mockStockAbi, normOf, normStep, nowTs, pokeMarket, priceOf, pushMockFeed, refreshMocks, valueOf, warpBy, freshen,
  type Abi, type Ctx, type Flow, type Row,
} from "./harness";

async function splitOne(ctx: Ctx, row: Row, symbol: "MCKA" | "MCKB"): Promise<void> {
  const embedded = symbol === "MCKA";
  const { m, g } = await mockEnv(ctx, row, symbol);
  const who = await fundRole(ctx, "carol", 100_000);
  const { got } = await buyDirect(ctx, row, "carol", g, 2_000_000_000n, `${symbol}: buy before the split`);
  await pokeMarket(ctx, row, symbol);
  const p0 = (await priceOf(ctx, symbol)).p;
  const [vBefore] = await valueOf(ctx, g.id);
  const eff = (await nowTs(ctx)) + 600n;
  await row.send(`${symbol}: schedule 2-for-1 (multiplier 1 to 2 in 10 min)`, "deployer", { address: m.stock, abi: mockStockAbi as Abi, functionName: "setMultipliers", args: [10n ** 18n, 2n * 10n ** 18n, eff] });
  await refreshMocks(ctx);
  const pending = await priceOf(ctx, symbol);
  row.chain(`${symbol}: buys paused for the split window`, Buffer.from(pending.reason.slice(2), "hex").toString().replace(/\0+$/, ""), "SPLIT_PENDING");
  await row.expectRevert(`${symbol}: buy during the split window`, "carol", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, 1_000_000_000n, 0n, who, (await nowTs(ctx)) + 3600n] }, ["BuysClosed"]);
  row.chain(`${symbol}: p unchanged while pending`, pending.p, p0);
  // the switch: multiplier 2 and the feed moves with it (per-share price halves when the guard multiplies; an embedded feed already quotes per token)
  await warpBy(ctx, 700);
  await row.send(`${symbol}: multiplier switches to 2`, "deployer", { address: m.stock, abi: mockStockAbi as Abi, functionName: "setMultipliers", args: [2n * 10n ** 18n, 2n * 10n ** 18n, eff] });
  if (!embedded) await pushMockFeed(ctx, row, m, 50n * 10n ** 8n, undefined, `${symbol}: feed per-share price halves to $50`);
  else await pushMockFeed(ctx, row, m, 100n * 10n ** 8n, undefined, `${symbol}: embedded feed keeps quoting $100 per token`);
  await refreshMocks(ctx);
  await pokeMarket(ctx, row, symbol);
  const after = await priceOf(ctx, symbol);
  row.chain(`${symbol}: p after the split == p before`, after.p, p0);
  const [vAfter] = await valueOf(ctx, g.id);
  const ns = await normOf(ctx, g.id);
  row.chainWithin(`${symbol}: value per token after == formula(p, NF now)`, vAfter, await formulaValueOf(ctx, g, after.p, ns.nf), 2n);
  // value unchanged by the split itself: only the toll over the elapsed time separates before and after
  const nfBefore = normStep(ns.nf, 0n, 0n);
  row.note(`${symbol}: value ${vBefore} -> ${vAfter} (toll over ${700}s only), nf ${nfBefore}`);
  row.chainTrue(`${symbol}: value moved only by the toll (<0.01 percent)`, vBefore - vAfter < vBefore / 10_000n && vAfter <= vBefore, `${vBefore} -> ${vAfter}`);
  row.chain(`${symbol}: balance unchanged`, (await (await import("./harness")).tokenOf(ctx, g.token, who)), got);
  // tail ends one hour after the switch; buys resume
  await warpBy(ctx, 3_700);
  await pushMockFeed(ctx, row, m, embedded ? 100n * 10n ** 8n : 50n * 10n ** 8n, undefined, `${symbol}: feed refreshed after the tail`);
  await refreshMocks(ctx);
  await pokeMarket(ctx, row, symbol);
  await freshen(ctx, [symbol]);
  await buyDirect(ctx, row, "carol", g, 1_000_000_000n, `${symbol}: buy resumes after the tail`);
  const [vResume] = await valueOf(ctx, g.id);
  row.chainTrue(`${symbol}: value after resume still about the same`, vBefore - vResume < vBefore / 1_000n, `${vBefore} -> ${vResume}`);
  void addressOf; void atNextSecond; void setPyth;
}

const H13: Flow = {
  id: "H13", area: "holders", kind: "success", name: "split day via the Stock Token multiplier: value per token unchanged, both feed kinds",
  async run(row, ctx) {
    await splitOne(ctx, row, "MCKA");
    await splitOne(ctx, row, "MCKB");
  },
};

export const flows: Flow[] = [H13];
