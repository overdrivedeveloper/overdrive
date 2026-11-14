// Holder flows H01 to H08, H14, H15 (todo 22b). H09 to H13 live in closed-market.ts and split-day.ts.
// Fixtures: the real ETH and BTC feeds (frozen at the fork block, always open) for the trade math; mock markets for the
// session flows. Governor capital is seeded once through its public deposit path (harness.ensureCapital).
import { IODGearRegistryAbi, IODMinterAbi } from "../../../src/abi";
import { addressOf } from "../lib";
import { flows as closedFlows } from "./closed-market";
import { flows as splitFlows } from "./split-day";
import {
  GEAR, POWER_OF, pollApi, accruePinned, apiBalance, apiGear, apiGet, atNextSecond, buyDirect, callAt, ensureCapital, ensureGear, ensureMockMarket,
  formulaValueOf, freshen, fundRole, minterQuote, nowTs, permitRouter, priceOf, sellDirect, syncDeployment, tokenOf, urSwapRequest, usdgOf,
  v4Quote, valueOf, warpBy, normOf, normStep, U, type Abi, type Ctx, type Flow, type GearInfo, type Row,
} from "./harness";

const SPORT_ETH = (ctx: Ctx, row: Row | null) => ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
const quoteUrl = (g: GearInfo, side: "buy" | "sell", amount: bigint, who: string) => `/v1/quote?gear=${g.id}&side=${side}&${side === "buy" ? "usdg" : "tokens"}=${amount}&account=${who}`;

const H01: Flow = {
  id: "H01", area: "holders", kind: "success", name: "buy each of the five powers and a pair gear through the hook pool; equals V4Quoter, minter and API quote",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const gears = [
      await ensureGear(ctx, row, "ETH", null, GEAR.CRUISE), await ensureGear(ctx, row, "ETH", null, GEAR.SPORT), await ensureGear(ctx, row, "MCKR", null, GEAR.RACE),
      await ensureGear(ctx, row, "ETH", null, GEAR.ECO), await ensureGear(ctx, row, "ETH", null, GEAR.REVERSE), await ensureGear(ctx, row, "ETH", "BTC", GEAR.SPORT),
    ];
    const who = await fundRole(ctx, "alice", 1_000_000);
    await permitRouter(ctx, row, "alice", ctx.usdg);
    const amount = U(1000);
    for (const g of gears) {
      await freshen(ctx, ["ETH", "BTC", "ETH/BTC", "MCKR"]);
      const before = await tokenOf(ctx, g.token, who);
      const paid0 = await usdgOf(ctx, who);
      const { v4, mq, req } = await atNextSecond(ctx, async (t) => ({
        v4: await v4Quote(ctx, t, g.id, true, amount), mq: await minterQuote(ctx, t, g.id, true, true, amount, who), req: await urSwapRequest(ctx, g.id, true, amount, g.token),
      }));
      await row.send(`hook buy ${g.key} (power ${POWER_OF[g.gear]}) 1000 USDG`, "alice", req);
      const got = (await tokenOf(ctx, g.token, who)) - before;
      row.chain(`${g.key} tokens == V4Quoter`, got, v4);
      row.chain(`${g.key} tokens == minter.quote`, got, mq.amountOut);
      row.chain(`${g.key} USDG paid`, paid0 - (await usdgOf(ctx, who)), amount);
      const acct = await apiBalance(who, await apiSymbol(g), await tokenOf(ctx, g.token, who));
      row.api(`${g.key} API account balance`, acct?.balance, await tokenOf(ctx, g.token, who));
      // BUG-1: the API quoter builds the pool key with fee 0x800000, the hook's pools use fee 0, so V4Quoter reverts
      await row.known("BUG-1", async () => {
        const api = await apiGet<{ buyable?: boolean; tokensOut?: string | null; error?: string }>(quoteUrl(g, "buy", amount, who));
        row.api(`${g.key} API quote buyable`, api.buyable, true);
        row.apiWithin(`${g.key} API tokensOut`, BigInt(api.tokensOut ?? "0"), got, got / 1_000_000n + 1n);
      });
    }
  },
};
async function apiSymbol(g: GearInfo): Promise<string> {
  const r = await apiGet<{ gears: { id: string; symbol: string }[] }>("/v1/gears");
  return r.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.symbol ?? g.id;
}

const H02: Flow = {
  id: "H02", area: "holders", kind: "success", name: "hold one day: NF drops by the toll, balance unchanged, value equals the formula within 1 unit",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await SPORT_ETH(ctx, row);
    await freshen(ctx, ["ETH"]);
    const who = await fundRole(ctx, "bob", 100_000);
    await buyDirect(ctx, row, "bob", g, U(5000), "bob buy ETH-SPORT");
    const got = await tokenOf(ctx, g.token, who);
    const before = await normOf(ctx, g.id);
    await warpBy(ctx, 86_400);
    await freshen(ctx, ["ETH"]);
    const acc = await accruePinned(ctx, row, g, "accrue after one day");
    row.chain("NF == ODNorm closed form", acc.accruedNf, acc.expectedNf);
    row.chainTrue("NF dropped (positive toll)", acc.after.nf < before.nf, `${before.nf} -> ${acc.after.nf}`);
    row.chain("balance unchanged", await tokenOf(ctx, g.token, who), got);
    const p = (await priceOf(ctx, "ETH")).p;
    const [v] = await valueOf(ctx, g.id);
    row.chainWithin("value per token == formula(p, p0, NF)", v, await formulaValueOf(ctx, g, p, acc.after.nf), 2n);
    const day = (acc.before.nf - acc.after.nf) * 10n ** 18n / acc.before.nf;
    row.note(`NF ${before.nf} -> ${acc.after.nf} over ${acc.dt}s (${day} wad of NF)`);
    const api = await apiGear(g.id);
    const ag = await pollApi(() => apiGear(g.id), (x) => x?.nf === acc.accruedNf.toString());
    row.api("API gear nf == Accrued event nf", ag?.nf, acc.accruedNf.toString());
    await apiBalance(who, await apiSymbol(g), got).then((a) => row.api("API balance unchanged", a?.balance, got));
  },
};

const H03: Flow = {
  id: "H03", area: "holders", kind: "success", name: "Eco toll is negative: NF and value rise by the toll over a day",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.ECO);
    await freshen(ctx, ["ETH"]);
    const who = await fundRole(ctx, "carol", 100_000);
    await buyDirect(ctx, row, "carol", g, U(5000), "carol buy ETH-ECO");
    const got = await tokenOf(ctx, g.token, who);
    const perDay = (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "tollPerDay", args: [g.id] })) as bigint;
    row.chainTrue("toll per day is negative", perDay < 0n, perDay);
    const [v0] = await valueOf(ctx, g.id);
    const base = await normOf(ctx, g.id);
    await warpBy(ctx, 86_400);
    await freshen(ctx, ["ETH"]);
    const acc = await accruePinned(ctx, row, g, "accrue Eco after one day");
    row.chain("NF == ODNorm closed form", acc.accruedNf, acc.expectedNf);
    row.chainTrue("NF rose", acc.after.nf > acc.before.nf, `${acc.before.nf} -> ${acc.after.nf}`);
    const [v1] = await valueOf(ctx, g.id);
    row.chainTrue("value per token rose by the toll", v1 > v0, `${v0} -> ${v1}`);
    row.chainWithin("value == formula", v1, await formulaValueOf(ctx, g, (await priceOf(ctx, "ETH")).p, acc.after.nf), 2n);
    row.chain("balance unchanged", await tokenOf(ctx, g.token, who), got);
    const api = await pollApi(() => apiGear(g.id), (x) => x?.nf === acc.accruedNf.toString());
    row.api("API holdersReceive", api?.holdersReceive, true);
    row.api("API nf == Accrued event nf", api?.nf, acc.accruedNf.toString());
  },
};

const H04: Flow = {
  id: "H04", area: "holders", kind: "success", name: "sell back: USDG received equals the minter and V4Quoter quote (direct path; the hook sell needs gear in the PoolManager)",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await SPORT_ETH(ctx, row);
    await freshen(ctx, ["ETH"]);
    const who = await fundRole(ctx, "alice", 100_000);
    const { got } = await buyDirect(ctx, row, "alice", g, U(2000), "alice buy for sell-back");
    await freshen(ctx, ["ETH"]);
    const q = await sellDirect(ctx, row, "alice", g, got, "alice sell all ETH-SPORT");
    row.chainTrue("sell was instant, not queued", !q.queued, q.queued);
    row.note("round trip: bought 2000 USDG, sold back for " + q.amountOut);
    row.chain("balance after sell", await tokenOf(ctx, g.token, who) >= 0n, true);
    await row.known("BUG-1", async () => {
      const api = await apiGet<{ usdgOut?: string | null }>(quoteUrl(g, "sell", got, who));
      row.api("API sell quote usdgOut", api.usdgOut, q.amountOut);
    });
  },
};

const H05: Flow = {
  id: "H05", area: "holders", kind: "expected_failure", name: "buy at the exact cap succeeds, one unit over reverts (CapExceeded)",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await ensureGear(ctx, row, "ETH", "BTC", GEAR.SPORT);
    await freshen(ctx, ["ETH", "BTC", "ETH/BTC"]);
    await fundRole(ctx, "carol", 100_000);
    await approveMin(ctx, row, "carol");
    const cap = ((await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: (await import("../../../src/abi")).IODGovernorAbi, functionName: "capOf", args: [g.id] })) as readonly [bigint, bigint]);
    const open = cap[1];
    const newCap = open + 100n * 10n ** 18n;
    await row.send("timelock: set cap to open + 100 USD", "timelock", { address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi as Abi, functionName: "setParams", args: [g.id, newCap, 40] });
    const snap = await ctx.test.snapshot();
    // find the largest accepted buy in one pinned second, show M+1 reverts in that same second, roll back, buy M for real
    let M = 0n;
    const T = await atNextSecond(ctx, async (t) => {
      let lo = U(1), hi = U(1000);
      const ok = async (x: bigint) => { try { await minterQuote(ctx, t, g.id, true, true, x, addressOf("carol")); return true; } catch { return false; } };
      while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (await ok(mid)) lo = mid; else hi = mid - 1n; }
      M = lo;
      await ctx.test.setNextBlockTimestamp({ timestamp: t });
      const names = await row.expectRevert("buy cap+1 unit reverts", "carol", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, M + 1n, 0n, addressOf("carol"), t + 3600n] }, ["CapExceeded", "BuysClosed"], t);
      row.note(`over-cap revert: ${names.join(",")}`);
      return t;
    });
    await ctx.test.revert({ id: snap });
    await ctx.test.setNextBlockTimestamp({ timestamp: T });
    const before = await tokenOf(ctx, g.token, addressOf("carol"));
    const q = await minterQuote(ctx, T, g.id, true, true, M, addressOf("carol"));
    await row.send(`buy exactly the cap (${M} USDG units)`, "carol", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, M, 0n, addressOf("carol"), T + 3600n] });
    row.chain("tokens == quote", (await tokenOf(ctx, g.token, addressOf("carol"))) - before, q.amountOut);
    const after = ((await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: (await import("../../../src/abi")).IODGovernorAbi, functionName: "capOf", args: [g.id] })) as readonly [bigint, bigint]);
    row.chainTrue("open value at the cap (within 1 USDG of it)", newCap - after[1] < 10n ** 12n && after[1] <= newCap, `${after[1]} vs ${newCap}`);
    await row.send("timelock: restore cap 5,000,000", "timelock", { address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi as Abi, functionName: "setParams", args: [g.id, 5_000_000n * 10n ** 18n, 40] });
  },
};
import { approveMinter } from "./harness";
const approveMin = (ctx: Ctx, row: Row, role: "carol" | "alice" | "bob") => approveMinter(ctx, row, role, ctx.usdg, ctx.c.ODMinter!);

const H06: Flow = {
  id: "H06", area: "holders", kind: "expected_failure", name: "buy below the minimum trade reverts BelowMinimum",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await SPORT_ETH(ctx, row);
    await freshen(ctx, ["ETH"]);
    await fundRole(ctx, "alice", 100_000);
    await approveMin(ctx, row, "alice");
    const min = ((await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "tradeParams" })) as { minTradeUsdg: bigint }).minTradeUsdg;
    await row.expectRevert(`buy ${min - 1n} units (min ${min})`, "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, min - 1n, 0n, addressOf("alice"), (await nowTs(ctx)) + 3600n] }, ["BelowMinimum"]);
    await row.send(`buy exactly the minimum (${min})`, "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, min, 0n, addressOf("alice"), (await nowTs(ctx)) + 3600n] });
  },
};

const H07: Flow = {
  id: "H07", area: "holders", kind: "expected_failure", name: "slippage bound one unit above the quote reverts Slippage",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await SPORT_ETH(ctx, row);
    await freshen(ctx, ["ETH"]);
    await fundRole(ctx, "alice", 100_000);
    await approveMin(ctx, row, "alice");
    await atNextSecond(ctx, async (t) => {
      const q = await minterQuote(ctx, t, g.id, true, true, U(1000), addressOf("alice"));
      await ctx.test.setNextBlockTimestamp({ timestamp: t });
      const names = await row.expectRevert("buy with minOut = quote + 1", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, U(1000), q.amountOut + 1n, addressOf("alice"), t + 3600n] }, ["Slippage"], t);
      row.note(`revert ${names.join(",")}`);
    });
  },
};

const H08: Flow = {
  id: "H08", area: "holders", kind: "expected_failure", name: "expired deadline reverts Expired",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await SPORT_ETH(ctx, row);
    await freshen(ctx, ["ETH"]);
    await fundRole(ctx, "alice", 100_000);
    await approveMin(ctx, row, "alice");
    const now = await nowTs(ctx);
    await row.expectRevert("buy with a deadline in the past", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, U(1000), 0n, addressOf("alice"), now - 10n] }, ["Expired"]);
    await row.expectRevert("sell with a deadline in the past", "alice", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "sell", args: [g.id, 1n, 0n, addressOf("alice"), now - 10n] }, ["Expired"]);
  },
};

const H14: Flow = {
  id: "H14", area: "holders", kind: "success", name: "transfer a gear token: balance and NF accrual follow the receiver",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await SPORT_ETH(ctx, row);
    await freshen(ctx, ["ETH"]);
    const a = await fundRole(ctx, "alice", 100_000);
    const b = addressOf("dave");
    await buyDirect(ctx, row, "alice", g, U(3000), "alice buy for transfer");
    const half = (await tokenOf(ctx, g.token, a)) / 2n;
    const dave0 = await tokenOf(ctx, g.token, b);
    const erc = (await import("../lib")).erc20Abi;
    const a0 = await tokenOf(ctx, g.token, a);
    await row.send("alice transfers half to dave", "alice", { address: g.token, abi: erc as Abi, functionName: "transfer", args: [b, half] });
    row.chain("dave balance", await tokenOf(ctx, g.token, b), dave0 + half);
    row.chain("alice balance", await tokenOf(ctx, g.token, a), a0 - half);
    const base = await normOf(ctx, g.id);
    await warpBy(ctx, 86_400);
    await freshen(ctx, ["ETH"]);
    const acc = await accruePinned(ctx, row, g, "accrue a day after the transfer");
    row.chain("NF == closed form", acc.accruedNf, acc.expectedNf);
    const kb = await tokenOf(ctx, g.token, b);
    row.chain("dave balance unchanged by accrual", kb, dave0 + half);
    const [v] = await valueOf(ctx, g.id);
    const sym = await apiSymbol(g);
    const wantValue = (kb * v) / 10n ** 30n;
    // the API value follows the indexed NF: poll until it catches up with the accrual (30 s)
    // BUG-2: the API's gear value (valueSource "trade") is the last trade's value, not the chain's value after the day's toll
    const acct = await pollApi(() => apiGet<{ balances: { gear: string; balance: string; valueUsdg: string }[] }>(`/v1/account/${b}`), (a) => {
      const x = a.balances.find((y) => y.gear === sym);
      return !!x && BigInt(x.balance) === kb && BigInt(x.valueUsdg) - wantValue <= 2n && wantValue - BigInt(x.valueUsdg) <= 2n;
    }, 8_000);
    const apiK = acct.balances.find((y) => y.gear === sym);
    row.api("API dave balance", apiK?.balance, kb);
    await row.known("BUG-2", () => row.apiWithin("API dave value (USDG units) == balance x value", BigInt(apiK?.valueUsdg ?? "0"), wantValue, 2n));
  },
};

const H15: Flow = {
  id: "H15", area: "holders", kind: "expected_failure", name: "sell with the exit reserve at its floor reverts with the documented error",
  async run(row, ctx) {
    const gov = (await import("../../../src/abi")).IODGovernorAbi;
    const floor = (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: gov, functionName: "exitReserveFloor" })) as bigint;
    const reserve = (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: gov, functionName: "exitReserve" })) as bigint;
    row.note(`exit reserve ${reserve}, floor ${floor}`);
    row.blocked("no honest way to put the Governor at the floor on the fork: a sell is only refused (UseQueue, API QUEUED) when cash + reserve + insurance cannot pay it, and no source here drains the Governor (the hedger cannot post live: HEDGER_DRY_RUN, 22a gap 2). The contract has no RESERVE_FLOOR revert (the API maps InsufficientCash to it, a moveToExitReserve error), so the todo wording does not match the code. Needs the hedger's transaction queue (todo 14) or a Governor-draining fixture from 22c");
  },
};

export async function prepare(ctx: Ctx): Promise<void> {
  await ensureCapital(ctx, null);
  await freshen(ctx, ["ETH", "BTC"]);
  await ensureMockMarket(ctx, "MCKA", true);
  await ensureMockMarket(ctx, "MCKB", false);
  for (const [a, b, g] of [["ETH", null, 0], ["ETH", null, 1], ["MCKR", null, 2], ["ETH", null, 3], ["ETH", null, 4], ["ETH", "BTC", 1], ["MCKA", null, 1], ["MCKB", null, 1]] as const) await ensureGear(ctx, null, a, b, g);
  if (await syncDeployment(ctx)) await Bun.sleep(5000);
}

// the session flows warp the clock by days and run last: the real feeds are frozen, so each warped day ages them toward their relaxed 30 day limit
export const flows: Flow[] = [H01, H02, H03, H04, H05, H06, H07, H08, H14, H15, ...closedFlows, ...splitFlows];
void callAt; void sellDirect;
