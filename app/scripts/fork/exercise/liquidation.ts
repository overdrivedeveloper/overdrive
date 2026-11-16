// Liquidation rows B05, B05b, B06, B07, B08 (todo 22c). B05 is driven by the REAL liquidator service (seal, wait, execute);
// the others call the same permissionless seal and execute functions directly so the timing and the failure paths are exact.
// The contract's split (ODLiquidation): bonus B = 5 percent of the DEBT value D (BONUS_BPS), not of the seized collateral;
// collateral seized = D + B when the vault covers it. Rows assert the contract's definition and note the todo wording.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { IODBackerAbi, IODGovernorAbi } from "../../../src/abi";
import { healthFromTuple, isLiquidatable } from "../../../src/liquidator/health";
import { addressOf, FORK_DIR } from "../lib";
import {
  GEAR, approveMinter, atNextSecond, buyDirect, ensureCapital, ensureGear, ensureMockMarket, freshen, fundRole, syncDeployment, gotoSession, nowTs, pushCalendar, pushMockFeed, refreshMocks,
  tokenOf, usdgOf, warpBy, U, type Ctx, type Flow, type GearInfo, type Row,
} from "./harness";
import {
  G, MCKR_PRICE, backerAbi, backerDebt, eventsOf, health, mintMax, moveMckr, openVault, prepareBackers, resetMckr, vaultOf, apiVault,
} from "./backers";

export const sql = () => postgres(`postgres://${process.env.USER ?? "postgres"}@127.0.0.1:${5433 + Number(process.env.PORT_OFFSET ?? 0)}/od_fork`, { max: 1, onnotice: () => {} });

export function stopService(name: string): void {
  try {
    const pid = Number(readFileSync(`${FORK_DIR}/pids/${name}.pid`, "utf8").trim());
    if (pid > 0) process.kill(pid);
  } catch { /* not running */ }
}

const up = (p: bigint, pct: number) => (p * BigInt(100 + pct)) / 100n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for `ok()` up to `ms`, polling. */
async function until<T>(ms: number, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) { await sleep(3000); v = await read(); }
  return v;
}

async function sealBatch(ctx: Ctx, row: Row, g: GearInfo, ids: bigint[], label: string) {
  const rec = await row.send(label, "liquidator", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "sealBatch", args: [g.id, ids], gas: G });
  const ev = (await eventsOf(ctx, rec.hash, backerAbi, "BatchSealed"))[0]!.args as { batchId: bigint; sealedValueWad: bigint; vaultIds: bigint[] };
  return ev;
}
async function readyAt(ctx: Ctx, batchId: bigint): Promise<bigint> {
  return ((await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "batchWindow", args: [batchId] })) as readonly [bigint, bigint])[0];
}
async function executeAt(ctx: Ctx, row: Row, batchId: bigint, label: string) {
  const at = await readyAt(ctx, batchId);
  await (await import("./harness")).nextBlockAtLeast(ctx, at);
  return row.send(label, "liquidator", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "executeBatch", args: [batchId], gas: 8_000_000n });
}
const D_OF = (tokens: bigint, sealed: bigint) => { const w = (tokens * sealed + 10n ** 18n - 1n) / 10n ** 18n; return (w + 10n ** 12n - 1n) / 10n ** 12n; };

const B05: Flow = {
  id: "B05", area: "liquidation", kind: "success",
  name: "price move below maintenance: the liquidator service seals, waits for the batch to be ready and executes; bonus is the contract's 5 percent, holder balances unchanged",
  async run(row, ctx) {
    const g = await ensureGear(ctx, row, "MCKR", null, GEAR.RACE);
    await fundRole(ctx, "backer", 100_000); await fundRole(ctx, "alice", 200_000); await fundRole(ctx, "backer2", 100_000);
    await resetMckr(ctx, row);
    // a holder with gear: its balance and the token supply must not move
    await buyDirect(ctx, row, "alice", g, U(5000), "alice buys MCKR-RACE (a holder)");
    const aliceBal = await tokenOf(ctx, g.token, addressOf("alice"));
    const sick = await openVault(ctx, row, "backer", g, U(1000), "open vault V1 (will fall below maintenance)");
    const tokens = await mintMax(ctx, row, "backer", sick, "V1 mints the maximum (250 percent)");
    const well = await openVault(ctx, row, "backer2", g, U(1000), "open vault V2 (stays healthy)");
    await mintMax(ctx, row, "backer2", well, "V2 mints a quarter of the maximum", 1n, 4n);
    const supply0 = (await ctx.pub.readContract({ address: g.token, abi: [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "totalSupply" })) as bigint;
    const v2Before = await vaultOf(ctx, well);
    // the service needs the vaults indexed before the move (the move itself makes V1 liquidatable)
    row.api("API sees V1", (await apiVault(sick, (v) => v.debtTokens === tokens.toString()))?.debtTokens, tokens.toString());
    const exec0 = await usdgOf(ctx, addressOf("liquidator"));
    const blk = await ctx.pub.getBlockNumber();
    await moveMckr(ctx, row, up(MCKR_PRICE, 10), "MCKR price +10 percent (Race ratio 250 -> 187 percent, maintenance 200)");
    const [, , r, , maint] = await health(ctx, sick);
    row.chainTrue("V1 is below maintenance after the move", r < maint, `${r} < ${maint}`);
    row.note("the liquidator service runs a pass every 30 s, executes after the seal delay plus its 60 s margin; waiting up to 6 min");
    const logs = await until(360_000, async () => {
      const ex = await ctx.pub.getContractEvents({ address: ctx.c.ODBacker!, abi: IODBackerAbi, eventName: "Liquidated", fromBlock: blk, args: { vaultId: sick } });
      return ex;
    }, (l) => l.length > 0);
    if (!logs.length) throw new Error("the liquidator service did not liquidate V1 within 6 minutes (see ~/.overdrive/fork/logs/liquidator.log)");
    const ev = logs[0]!.args as { batchId: bigint; debtTokens: bigint; collateralSeized: bigint; bonusUsdg: bigint; badDebtUsdg: bigint };
    const seal = (await ctx.pub.getContractEvents({ address: ctx.c.ODBacker!, abi: IODBackerAbi, eventName: "BatchSealed", fromBlock: blk, args: { batchId: ev.batchId } }))[0]!;
    const sealedBy = (await ctx.pub.getTransaction({ hash: seal.transactionHash! })).from;
    row.chain("the service account sealed the batch", sealedBy, addressOf("liquidator"));
    const sv = (seal.args as { sealedValueWad: bigint }).sealedValueWad;
    const D = D_OF(tokens, sv), B = (D * 500n) / 10000n;
    row.chain("Liquidated.debtTokens", ev.debtTokens, tokens);
    row.chain("bonus == 5 percent of the debt value D at the sealed value", ev.bonusUsdg, B);
    row.chain("collateral seized == D + bonus (the vault covered it)", ev.collateralSeized, D + B);
    row.chain("no bad debt", ev.badDebtUsdg, 0n);
    row.note(`D=${D} B=${B}: bonus is ${(Number(B) / Number(D + B) * 100).toFixed(2)}% of seized collateral, 5% of the debt value (todo wording differs)`);
    row.chain("executor received the bonus", (await usdgOf(ctx, addressOf("liquidator"))) - exec0 >= B, true);
    const v1 = await vaultOf(ctx, sick);
    row.chain("V1 debt cleared", v1[3], 0n);
    row.chainWithin("V1 surplus returned to the vault (collateral less D and B, less the toll charged at execution)", v1[2], U(1000) - D - B, 10_000n);
    row.chain("holder (alice) gear balance unchanged", await tokenOf(ctx, g.token, addressOf("alice")), aliceBal);
    row.chain("gear supply unchanged", (await ctx.pub.readContract({ address: g.token, abi: [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "totalSupply" })) as bigint, supply0);
    const v2 = await vaultOf(ctx, well);
    row.chain("healthy V2 untouched (collateral)", v2[2] >= v2Before[2] - 5_000n, true);
    row.chain("healthy V2 untouched (debt)", v2[3], v2Before[3]);
    const q = sql();
    try {
      const rows = await until(45_000, () => q`select bonus_usdg::text as b, bad_debt_usdg::text as d from liquidations where vault_id = ${sick.toString()}`, (x) => x.length > 0);
      row.api("indexed liquidation bonus", rows[0]?.b, B.toString());
      row.api("indexed bad debt", rows[0]?.d, "0");
      const batch = await until(45_000, () => q`select status from liquidation_batches where batch_id = ${ev.batchId.toString()}`, (x) => x.length > 0 && x[0]!.status !== "sealed");
      row.api("indexed batch no longer open", batch[0]?.status !== "sealed", true);
    } finally { await q.end({ timeout: 2 }); }
    await resetMckr(ctx, row);
    stopService("liquidator"); // the next rows seal and execute by hand
  },
};

const B05b: Flow = {
  id: "B05b", area: "liquidation", kind: "success",
  name: "a vault rescued after the seal is released, not liquidated; an expired batch cannot execute and a fresh seal re-verifies health (price recovered: NONE_UNHEALTHY)",
  async run(row, ctx) {
    stopService("liquidator");
    const g = await ensureGear(ctx, row, "MCKR", null, GEAR.RACE);
    await fundRole(ctx, "backer", 100_000); await fundRole(ctx, "backer2", 100_000);
    await resetMckr(ctx, row);
    const rescued = await openVault(ctx, row, "backer", g, U(1000), "open vault R (will be rescued)");
    await mintMax(ctx, row, "backer", rescued, "R mints the maximum");
    const doomed = await openVault(ctx, row, "backer2", g, U(1000), "open vault X (will be liquidated)");
    const tokensX = await mintMax(ctx, row, "backer2", doomed, "X mints the maximum");
    await moveMckr(ctx, row, up(MCKR_PRICE, 10), "MCKR price +10 percent");
    const ev = await sealBatch(ctx, row, g, [rescued, doomed], "seal a batch with R and X");
    row.chain("both vaults sealed", ev.vaultIds.length, 2);
    await row.expectRevert("execute before the seal delay", "liquidator", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "executeBatch", args: [ev.batchId] }, ["BatchNotReady"]);
    await row.expectRevert("owner of sealed R withdraws", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "withdraw", args: [rescued, 1n, addressOf("backer")] }, ["InBatch"]);
    // the owner of R tops it up so it is healthy at the sealed value
    const need = U(1000);
    await approveMinter(ctx, row, "backer", ctx.usdg, ctx.c.ODBacker!);
    await row.send("R's owner tops up 1000 USDG after the seal", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "deposit", args: [rescued, need], gas: G });
    const rBefore = await vaultOf(ctx, rescued);
    const ex = await executeAt(ctx, row, ev.batchId, "execute the batch");
    const liq = await eventsOf(ctx, ex.hash, backerAbi, "Liquidated");
    row.chain("only X was liquidated", liq.map((l) => l.args.vaultId).join(","), doomed.toString());
    row.chain("X debt tokens", liq[0]!.args.debtTokens, tokensX);
    const rAfter = await vaultOf(ctx, rescued);
    row.chainWithin("R untouched: collateral (less toll)", rAfter[2], rBefore[2], 10_000n);
    row.chain("R untouched: debt", rAfter[3], rBefore[3]);
    await row.send("R's owner withdraws 1 unit (no longer InBatch)", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "withdraw", args: [rescued, 1n, addressOf("backer")], gas: G });
    // expiry: seal again, let the TTL (15 min) pass, then execute must revert BatchExpired
    const exp = await openVault(ctx, row, "backer2", g, U(1000), "open vault E (for the expiry check)");
    // E opened above the moved price: it mints at the current price, so move the price once more to make it sick
    await mintMax(ctx, row, "backer2", exp, "E mints the maximum at the moved price");
    await moveMckr(ctx, row, up(up(MCKR_PRICE, 10), 10), "MCKR price +10 percent again");
    const ev2 = await sealBatch(ctx, row, g, [exp], "seal a batch with E");
    await warpBy(ctx, 16 * 60);
    await row.expectRevert("execute after the 15 minute TTL", "liquidator", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "executeBatch", args: [ev2.batchId] }, ["BatchExpired"]);
    // the price recovers while the batch sat unexecuted: a fresh seal is verified against the CURRENT price
    await freshen(ctx, ["ETH", "MCKR"]);
    await resetMckr(ctx, row);
    await row.expectRevert("re-seal E after the price recovered", "liquidator", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "sealBatch", args: [g.id, [exp]] }, ["SealRefused"]);
    row.chain("E still holds its debt and collateral (nothing was liquidated)", (await vaultOf(ctx, exp))[3] > 0n, true);
    // and when it is still sick, a new seal succeeds as a new batch
    // two in-band steps from the reset price: one +21 percent print is a continuity jump the guard refuses to liquidate on
    await moveMckr(ctx, row, up(MCKR_PRICE, 10), "MCKR price +10 percent (E sick, step 1)");
    await moveMckr(ctx, row, up(up(MCKR_PRICE, 10), 10), "MCKR price up again (E sick)");
    const ev3 = await sealBatch(ctx, row, g, [exp], "re-seal E: a NEW batch (not the expired one)");
    row.chainTrue("new batch id", ev3.batchId > ev2.batchId, `${ev3.batchId} > ${ev2.batchId}`);
    await resetMckr(ctx, row);
  },
};

const B06: Flow = {
  id: "B06", area: "liquidation", kind: "success", name: "a healthy vault listed in the same batch window is left untouched; only the sick one is sealed and liquidated",
  async run(row, ctx) {
    stopService("liquidator");
    const g = await ensureGear(ctx, row, "MCKR", null, GEAR.RACE);
    await fundRole(ctx, "backer", 100_000); await fundRole(ctx, "backer2", 100_000);
    await resetMckr(ctx, row);
    const sick = await openVault(ctx, row, "backer", g, U(1000), "open sick vault S");
    await mintMax(ctx, row, "backer", sick, "S mints the maximum");
    const fine = await openVault(ctx, row, "backer2", g, U(1000), "open healthy vault H");
    await mintMax(ctx, row, "backer2", fine, "H mints a quarter of the maximum", 1n, 4n);
    const hBefore = await vaultOf(ctx, fine);
    await moveMckr(ctx, row, up(MCKR_PRICE, 10), "MCKR price +10 percent");
    const ev = await sealBatch(ctx, row, g, [sick, fine], "seal listing both S and H");
    row.chain("the batch holds only the sick vault", ev.vaultIds.map(String).join(","), sick.toString());
    row.chain("H not in a batch", (await vaultOf(ctx, fine))[4], 0n);
    const ex = await executeAt(ctx, row, ev.batchId, "execute the batch");
    const liq = await eventsOf(ctx, ex.hash, backerAbi, "Liquidated");
    row.chain("exactly one vault liquidated", liq.length, 1);
    const hAfter = await vaultOf(ctx, fine);
    row.chain("H collateral unchanged", hAfter[2] >= hBefore[2] - 5_000n, true);
    row.chain("H debt unchanged", hAfter[3], hBefore[3]);
    const api = await apiVault(fine, (v) => v.belowMaintenance === false);
    row.api("API: H is not below maintenance", api?.belowMaintenance, false);
    await resetMckr(ctx, row);
  },
};

const B08: Flow = {
  id: "B08", area: "liquidation", kind: "success", name: "deep shortfall: insurance pays the gap first, the rest is bad debt recorded on chain and in the index",
  async run(row, ctx) {
    stopService("liquidator");
    const g = await ensureGear(ctx, row, "MCKR", null, GEAR.RACE);
    await fundRole(ctx, "backer", 400_000);
    await resetMckr(ctx, row);
    const ins = ctx.c.ODInsurance!;
    const vid = await openVault(ctx, row, "backer", g, U(200_000), "open a large vault, 200000 USDG");
    const tokens = await mintMax(ctx, row, "backer", vid, "mint the maximum");
    // three +14 percent steps (guard continuity band): value x 1.14^9 is far past 105 percent
    let p = MCKR_PRICE;
    for (let i = 0; i < 3; i++) { p = up(p, 14); await moveMckr(ctx, row, p, `MCKR price +14 percent (step ${i + 1})`); }
    const [coll, debtWad, ratio] = await health(ctx, vid);
    row.chainTrue("the vault is under water (ratio below 105 percent)", ratio < 10500n, ratio);
    const insBefore = await usdgOf(ctx, ins);
    row.chainTrue("insurance holds less than the gap (so bad debt remains)", insBefore < (debtWad / 10n ** 12n) * 105n / 100n - coll, `${insBefore}`);
    const ev = await sealBatch(ctx, row, g, [vid], "seal the under-water vault");
    const debtBefore = await backerDebt(ctx, g.id);
    const ex = await executeAt(ctx, row, ev.batchId, "execute: insurance, then Governor equity, absorb the loss");
    const l = (await eventsOf(ctx, ex.hash, backerAbi, "Liquidated"))[0]!.args as { collateralSeized: bigint; bonusUsdg: bigint; badDebtUsdg: bigint; debtTokens: bigint };
    const D = D_OF(tokens, ev.sealedValueWad);
    row.chain("insurance drained to what it held", await usdgOf(ctx, ins), 0n);
    row.chainWithin("collateral seized is all of the vault collateral (less toll charged at execution)", l.collateralSeized, coll, 100_000n);
    row.chain("bad debt == D - USDG sent to the Governor (collateral + insurance cover - bonus)", l.badDebtUsdg, D - (l.collateralSeized + insBefore - l.bonusUsdg));
    row.chainTrue("bad debt is positive", l.badDebtUsdg > 0n, l.badDebtUsdg);
    row.chain("Governor backerDebt fell by the debt", debtBefore - (await backerDebt(ctx, g.id)), tokens);
    const q = sql();
    try {
      const rows = await until(45_000, () => q`select bad_debt_usdg::text as d from liquidations where vault_id = ${vid.toString()}`, (x) => x.length > 0);
      row.api("indexed bad_debt_usdg", rows[0]?.d, l.badDebtUsdg.toString());
    } finally { await q.end({ timeout: 2 }); }
    void IODGovernorAbi;
    await resetMckr(ctx, row);
  },
};

const B07: Flow = {
  id: "B07", area: "liquidation", kind: "success",
  name: "weekend uplift: a vault healthy before the lead window is liquidatable inside it (maintenance +50 points); the contract, the liquidator rule and the API agree",
  async run(row, ctx) {
    stopService("liquidator");
    const m = await ensureMockMarket(ctx, "MCKA", true);
    void m;
    const g = await ensureGear(ctx, row, "MCKA", null, GEAR.SPORT);
    // the API resolves gears and markets only from deployment.json: write the mock gear in and restart the stack (22b gap 2)
    if (await syncDeployment(ctx)) row.note("synced deployment.json with the mock gear and restarted the stack");
    stopService("liquidator");
    await fundRole(ctx, "backer", 100_000);
    await gotoSession(ctx, "open", "MCKA", row);
    await freshen(ctx, ["ETH", "MCKA"]);
    const vid = await openVault(ctx, row, "backer", g, U(1000), "open MCKA-SPORT vault");
    await mintMax(ctx, row, "backer", vid, "mint the maximum (200 percent)");
    const upl = (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "upliftActive", args: [g.marketA] })) as readonly [boolean, number];
    row.chain("no uplift on an ordinary open session", upl[0], false);
    const h0 = await health(ctx, vid);
    row.chain("maintenance is the base 150 percent", h0[4], 15000n);
    await row.expectRevert("seal a healthy vault", "liquidator", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "sealBatch", args: [g.id, [vid]] }, ["SealRefused"]);
    // into the last hour before the Friday close: the uplift window (lead 2 h) opens
    const { warpTarget } = await import("../warp");
    const now = Number(await nowTs(ctx));
    let target = warpTarget(now, "to-weekend") - 63_000; // Saturday 12:00 NY minus 17.5 h = Friday 18:30 NY (extended session, 90 min before the 20:00 close, inside the 2 h lead)
    if (target <= now) target = warpTarget(now + 3 * 86_400, "to-weekend") - 63_000;
    await pushCalendar(ctx, row);
    await ctx.test.increaseTime({ seconds: target - now });
    await ctx.test.mine({ blocks: 1 });
    await pushCalendar(ctx, row);
    const dw = (await import("../lib")).walletFor("deployer");
    for (const mk of ctx.mocks.values()) {
      const [, answer] = (await ctx.pub.readContract({ address: mk.feed, abi: (await import("./harness")).mockFeedAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
      await ctx.pub.waitForTransactionReceipt({ hash: await dw.writeContract({ address: mk.feed, abi: (await import("./harness")).mockFeedAbi, functionName: "setRound", args: [answer, await nowTs(ctx)], chain: null, account: dw.account! } as never) });
    }
    await freshen(ctx, ["ETH", "MCKA"]);
    const u1 = (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "upliftActive", args: [g.marketA] })) as readonly [boolean, number];
    row.chain("uplift active inside the lead window", u1[0], true);
    row.chain("uplift is 50 points", u1[1], 5000);
    // nudge the price 4 percent against the vault: base maintenance (150) would still be healthy, uplifted (200) is not
    const mk = await ensureMockMarket(ctx, "MCKA", true);
    const [, cur] = (await ctx.pub.readContract({ address: mk.feed, abi: (await import("./harness")).mockFeedAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
    await pushMockFeed(ctx, row, mk, (cur * 104n) / 100n, undefined, "MCKA price +4 percent");
    await refreshMocks(ctx);
    const hT = (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "health", args: [vid] })) as readonly [bigint, bigint, bigint, bigint, bigint];
    row.chain("maintenance with uplift is 200 percent", hT[4], 20000n);
    row.chainTrue("ratio below the uplifted maintenance but above the base", hT[2] < 20000n && hT[2] > 15000n, hT[2]);
    row.chain("liquidator rule isLiquidatable agrees with the contract", isLiquidatable(healthFromTuple(hT)), true);
    const api = await apiVault(vid, (v) => v.belowMaintenance === true && (v.weekendUplift as { active?: boolean } | undefined)?.active === true);
    row.api("API belowMaintenance", api?.belowMaintenance, true);
    // BUG-3: /v1/vaults reports weekendUplift.active=false while the same response's maintenanceBps is 20000 (uplifted) and
    // backer.upliftActive(MCKA) is true on chain: the route resolves the underlying market from the indexed gear row and
    // gets undefined for this gear, so it never calls upliftActive.
    await row.known("BUG-3", () => row.api("API weekendUplift.active", (api?.weekendUplift as { active?: boolean } | undefined)?.active, true));
    const ev = await sealBatch(ctx, row, g, [vid], "seal: the contract seals it too (uplift counted)");
    row.chain("sealed the vault", ev.vaultIds.map(String).join(","), vid.toString());
    const ex = await executeAt(ctx, row, ev.batchId, "execute the uplift batch");
    row.chain("liquidated", (await eventsOf(ctx, ex.hash, backerAbi, "Liquidated")).length, 1);
      },
};

export const flows: Flow[] = [B05, B05b, B06, B08, B07];
export const prepare = async (ctx: Ctx) => {
  await prepareBackers(ctx);
  await ensureCapital(ctx, null);
  // the API and the indexer resolve gears and markets only from deployment.json: list the mock gears (MCKR, MCKA) before any row (22b gap 2)
  await ensureMockMarket(ctx, "MCKA", true);
  await ensureGear(ctx, null, "MCKA", null, GEAR.SPORT);
  if (await syncDeployment(ctx)) await Bun.sleep(8000);
};
