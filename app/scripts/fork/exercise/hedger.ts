// Service rows G05 to G09 (todo 22c): hedger, risk-sim, crank toll job, vol-engine.
// G05/G06 run the hedger's own code in process (runHedgeCycle on the mock venue, runHedgePosts), with the postHedge dep
// sending the real transaction as the hedger role. The bin cannot do that itself (src/bin/hedger.ts refuses live
// posting until the transaction queue lands, todo 14), so the live service stays in dry run and is stopped for these rows.
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { IODGovernorAbi, IODMinterAbi, IODVolOracleAbi } from "../../../src/abi";
import { createChainExposureReader, type IndexedReader } from "../../../src/hedger/exposure";
import { oracleMarkAgeMs, type HedgeMarket } from "../../../src/hedger/markets";
import { runHedgeCycle, type CycleDeps } from "../../../src/hedger/service";
import { newHedgerState } from "../../../src/hedger/state";
import { testSettings, silent } from "../../../src/hedger/test-support";
import { MockVenue } from "../../../src/hedger/venues/mock-venue";
import { newPostState, runHedgePosts, type PostDeps } from "../../../src/hedger/venues/equity";
import { createMemoryHedgerStore } from "../../../src/db/queries/hedges";
import { usdgToWad, wadToUsdg } from "../../../src/lib/fixed";
import { accrueInBatches } from "../../../src/crank/jobs/toll";
import { createGasTuner } from "../../../src/crank/gas";
import { IODOracleGuardAbi } from "../../../src/abi";
import { addressOf, asTimelock, keyOf, walletFor } from "../lib";
import { marketId } from "../setup";
import {
  GEAR, pokeMarket, buyDirect, ensureCapital, ensureGear, ensureMockMarket, freshen, fundRole, gotoSession, nowTs, priceOf, U, normOf, volKey, postVol,
  pollApi, type Ctx, type Flow, type Row,
} from "./harness";
import { stopService, sql } from "./liquidation";
import { privateKeyToAccount } from "viem/accounts";

const HEDGER_ROLE = keccak256(stringToHex("HEDGER_ROLE"));
const gov = (ctx: Ctx) => ctx.c.ODGovernor!;
const readGov = <T,>(ctx: Ctx, functionName: string, args: readonly unknown[] = []) =>
  ctx.pub.readContract({ address: gov(ctx), abi: IODGovernorAbi, functionName, args } as never) as Promise<T>;
const reasonOf = (b: string) => Buffer.from(b.slice(2), "hex").toString().replace(/\0+$/, "");
const ethMarket: HedgeMarket = { market: marketId("ETH"), symbol: "ETH", kind: "crypto", alwaysOpen: true };

/** Everything one in-process hedger needs: a chain-clock, the mock venue, the cycle deps and the post deps. */
function hedgerKit(ctx: Ctx, row: Row, markets: HedgeMarket[], venue: MockVenue, markAge: Map<string, number>) {
  const clock = { ms: 0 };
  const chain = createChainExposureReader(ctx.pub as never, gov(ctx));
  const indexed: IndexedReader & { override: Map<string, { delta: bigint } | null> } = {
    override: new Map(),
    // the indexed cross-check is proven row by row in G04; here the book mirrors the chain unless a row overrides it
    async latest(symbol, atOrBefore) {
      const e = await chain.exposure(markets.find((m) => m.symbol === symbol)!.market, symbol, atOrBefore);
      const o = this.override.get(symbol);
      return { block: atOrBefore, ts: new Date(clock.ms), deltaUsd: o ? o.delta : wadToUsdg(e.deltaUsdWad), gammaUsd: wadToUsdg(e.gammaUsdWad), equityUsd: wadToUsdg(e.equityWad) };
    },
  };
  const mem = createMemoryHedgerStore();
  const state = newHedgerState();
  const sync = async () => { clock.ms = Number(await nowTs(ctx)) * 1000; };
  const cycleDeps: CycleDeps = {
    markets, chain, indexed, venues: [venue], store: mem.store, state, logger: silent, now: () => clock.ms,
    settings: testSettings({ cooldownSeconds: 0, minTradeUsd: U(5), bandBps: 50, hardBandBps: 200 }),
    markAgeMs: async (m) => markAge.get(m.symbol) ?? 0,
  };
  const postState = newPostState();
  const postDeps: PostDeps = {
    markets, venues: [venue], store: mem.store, logger: silent, now: () => clock.ms, dryRun: false, state: postState,
    chainTimeS: async () => Number(await nowTs(ctx)),
    governorConfig: async () => ({ hedgeMaxAgeS: Number(await readGov<number>(ctx, "hedgeMaxAge")) }),
    jumpRange: async (market) => { const [lo, hi] = await readGov<readonly [bigint, bigint]>(ctx, "hedgeJumpRange", [market]); return { lo, hi }; },
    async postHedge(market, delta, equity, asOf) {
      const rec = await row.send(`postHedge ${market.slice(0, 10)} (as the hedger role)`, "hedger", { address: gov(ctx), abi: IODGovernorAbi as never, functionName: "postHedge", args: [market, delta, equity, asOf], gas: 600_000n });
      if (rec.status !== "success") throw new Error(`postHedge reverted ${rec.hash}`);
    },
  };
  return { cycleDeps, postDeps, sync, indexed, mem, clock };
}

async function ensureHedgerRole(ctx: Ctx, row: Row): Promise<void> {
  const has = (await ctx.pub.readContract({ address: gov(ctx), abi: [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }], functionName: "hasRole", args: [HEDGER_ROLE, addressOf("hedger")] })) as boolean;
  if (has) return;
  const hash = await asTimelock((w, tl) => w.writeContract({ address: gov(ctx), abi: [{ type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] }], functionName: "grantRole", args: [HEDGER_ROLE, addressOf("hedger")], gas: 300_000n, chain: null, account: tl } as never));
  await ctx.pub.waitForTransactionReceipt({ hash });
  row.note("granted HEDGER_ROLE to the hedger key through the timelock (fork setup)");
}


/** Re-posts every live hedge unchanged at the current chain time (what the hedger does at half of hedgeMaxAge). Warping rows would
 * otherwise leave the Governor HEDGE_STALE for the rows that follow. */
async function refreshHedges(ctx: Ctx, row: Row): Promise<void> {
  for (const m of ["ETH", "MCKA", "MCKR"]) {
    const id = marketId(m);
    const h = await readGov<readonly [bigint, bigint, bigint]>(ctx, "hedgeOf", [id]);
    if (h[0] === 0n && h[1] === 0n) continue;
    await row.send(`refresh hedge post ${m} (hedger role)`, "hedger", { address: gov(ctx), abi: IODGovernorAbi as never, functionName: "postHedge", args: [id, h[0], h[1], await nowTs(ctx)], gas: 600_000n });
  }
}

const markWad = async (ctx: Ctx, symbol: string) => {
  const p = (await priceOf(ctx, symbol)).p;
  return p < 10n ** 12n ? p * 10n ** 10n : p; // the guard reports 8-decimal or WAD prices
};

/** Open an ETH book on the Governor (two gears) and return the exposure the hedger must offset. */
async function ethBook(ctx: Ctx, row: Row): Promise<void> {
  await refreshHedges(ctx, row);
  await ensureCapital(ctx, row);
  const g1 = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
  await fundRole(ctx, "alice", 200_000);
  await freshen(ctx, ["ETH"]);
  await buyDirect(ctx, row, "alice", g1, U(30_000), "alice buys ETH-SPORT (hedger book)");
  await freshen(ctx, ["ETH"]);
}

const G05: Flow = {
  id: "G05", area: "services", kind: "success",
  name: "hedger on the mock venue: residual inside the band after each cycle, closed-feed weekend hedge on the 24/7 mock, postHedge after each cycle, a lapse past hedgeMaxAge pauses buys and a fresh post resumes them",
  async run(row, ctx) {
    const hold: { fn?: () => Promise<void> } = {};
    try { await (async () => {
    stopService("hedger"); // the live service is dry run; this row drives the same code in process with live posting
    await ensureHedgerRole(ctx, row);
    await ethBook(ctx, row);
    const mockA = await ensureMockMarket(ctx, "MCKA", true);
    void mockA;
    const venue = new MockVenue({ name: "mock", marks: { ETH: await markWad(ctx, "ETH") }, alwaysOpen: true });
    const kit = hedgerKit(ctx, row, [ethMarket], venue, new Map());
    hold.fn = () => refreshHedges(ctx, row);
    // eth_getLogs is capped at 10 blocks on the upstream plan, so the post count is read from this row's own transactions
    const events = async () => row.txs.filter((t) => t.label.startsWith("postHedge") && t.status === "success").length;
    const ev0 = await events();

    // cycle 1: the venue is flat, the Governor is long: the hedger must buy until the residual is inside the band
    await kit.sync();
    const r1 = await runHedgeCycle(kit.cycleDeps);
    const n1 = r1.names.ETH!;
    row.chain("cycle 1 traded ETH", n1.action, "traded");
    const exp1 = await readGov<readonly [bigint, bigint, bigint]>(ctx, "exposure", [ethMarket.market]);
    const delta1 = wadToUsdg(exp1[0]);
    const pos1 = await venue.netPositionUsd("ETH");
    row.chainTrue("delta residual inside the band after cycle 1", (delta1 - pos1 < 0n ? pos1 - delta1 : delta1 - pos1) <= n1.bandUsd, `delta ${delta1} venue ${pos1} band ${n1.bandUsd}`);
    row.chainTrue("the hedge is long (holders are long)", pos1 > 0n, pos1);
    let posts = await runHedgePosts(kit.postDeps, new Set(["ETH"]));
    row.chain("post 1 posted", posts.ETH?.action, "posted");
    const h1 = await readGov<readonly [bigint, bigint, bigint]>(ctx, "hedgeOf", [ethMarket.market]);
    row.chain("postHedge stored the venue hedge delta (WAD)", h1[0], usdgToWad(pos1));
    row.chainTrue("posted asOf is the chain time", h1[2] > (await nowTs(ctx)) - 60n, h1[2]);
    row.chain("HedgePosted events after cycle 1", (await events()) - ev0, 1);

    // cycle 2: more holder exposure, the hedger trades again and posts again
    const g1 = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    await buyDirect(ctx, row, "alice", g1, U(20_000), "alice buys more ETH-SPORT");
    await freshen(ctx, ["ETH"]);
    await kit.sync();
    const r2 = await runHedgeCycle(kit.cycleDeps);
    const n2 = r2.names.ETH!;
    row.chain("cycle 2 traded ETH", n2.action, "traded");
    const exp2 = await readGov<readonly [bigint, bigint, bigint]>(ctx, "exposure", [ethMarket.market]);
    const d2 = wadToUsdg(exp2[0]) - (await venue.netPositionUsd("ETH"));
    row.chainTrue("delta residual inside the band after cycle 2", (d2 < 0n ? -d2 : d2) <= n2.bandUsd, `residual ${d2} band ${n2.bandUsd}`);
    posts = await runHedgePosts(kit.postDeps, new Set(["ETH"]));
    row.chain("post 2 posted", posts.ETH?.action, "posted");
    row.chain("HedgePosted events after cycle 2", (await events()) - ev0, 2);

    // the post is also re-sent before hedgeMaxAge: half way through the window a quiet cycle still posts (not_due before it)
    const maxAge = Number(await readGov<number>(ctx, "hedgeMaxAge"));
    await ctx.test.increaseTime({ seconds: Math.floor(maxAge / 2) + 30 }); await ctx.test.mine({ blocks: 1 });
    await freshen(ctx, ["ETH"]);
    await kit.sync();
    posts = await runHedgePosts(kit.postDeps, new Set());
    row.chain("a quiet cycle re-posts at half of hedgeMaxAge", posts.ETH?.action, "posted");
    row.chain("not stale after the re-post", await readGov<boolean>(ctx, "hedgeStale"), false);

    // lapse: nothing posts for longer than hedgeMaxAge -> the Governor pauses buys (HEDGE_STALE); a fresh post resumes them
    await ctx.test.increaseTime({ seconds: maxAge + 60 }); await ctx.test.mine({ blocks: 1 });
    await freshen(ctx, ["ETH"]);
    row.chain("hedgeStale after the lapse", await readGov<boolean>(ctx, "hedgeStale"), true);
    const [paused, why] = await readGov<readonly [boolean, string]>(ctx, "buysPaused");
    row.chain("buys paused", paused, true);
    row.chain("pause reason", reasonOf(why), "HEDGE_STALE");
    let refused = false;
    try { await buyDirect(ctx, row, "alice", g1, U(1_000), "alice buys while the hedge is stale"); } catch { refused = true; }
    row.chain("a holder buy is refused while buys are paused", refused, true);
    await kit.sync();
    posts = await runHedgePosts(kit.postDeps, new Set());
    row.chain("the hedger posts again after the lapse", posts.ETH?.action, "posted");
    row.chain("hedgeStale cleared by the fresh post", await readGov<boolean>(ctx, "hedgeStale"), false);
    row.chain("buys resume (not paused)", (await readGov<readonly [boolean, string]>(ctx, "buysPaused"))[0], false);
    await buyDirect(ctx, row, "alice", g1, U(1_000), "alice buys after the fresh post");

    // closed-feed weekend hedge on the 24/7 mock: a stock market with a closed session, a venue that trades every hour
    const mckaGear = await ensureGear(ctx, row, "MCKA", null, GEAR.SPORT);
    await gotoSession(ctx, "open", "MCKA", row);
    await freshen(ctx, ["ETH", "MCKA"]);
    // the warp to the next open is longer than hedgeMaxAge: the hedger re-posts first, or the Governor refuses the buy (HEDGE_STALE)
    await kit.sync();
    await runHedgePosts(kit.postDeps, new Set(["ETH"]));
    await fundRole(ctx, "bob", 100_000);
    await buyDirect(ctx, row, "bob", mckaGear, U(25_000), "bob buys MCKA-SPORT (open session)");
    await pokeMarket(ctx, row, "MCKA"); // records the guard's last good price: what a closed market reports through the weekend
    await gotoSession(ctx, "weekend", "MCKA", row);
    await freshen(ctx, ["ETH", "MCKA"]);
    row.chain("MCKA session is closed (weekend)", (await priceOf(ctx, "MCKA")).session, 2);
    const mcka: HedgeMarket = { market: marketId("MCKA"), symbol: "MCKA", kind: "stock", alwaysOpen: false };
    const wvenue = new MockVenue({ name: "mock", marks: { MCKA: await markWad(ctx, "MCKA"), ETH: await markWad(ctx, "ETH") }, alwaysOpen: true });
    const ages = new Map<string, number>();
    const wk = hedgerKit(ctx, row, [ethMarket, mcka], wvenue, ages);
    hold.fn = () => refreshHedges(ctx, row);
    await wk.sync();
    const guardMcka = (await ctx.pub.readContract({ address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi, functionName: "read", args: [mcka.market] })) as { fresh: boolean; session: number; updatedAt: bigint };
    row.chain("the guard reads the closed MCKA market as fresh (last good price)", guardMcka.fresh, true);
    // the bin's own rule for the oracle input age: a closed feed is not stale
    const nowMs = Number(await nowTs(ctx)) * 1000;
    ages.set("MCKA", oracleMarkAgeMs(guardMcka, nowMs));
    row.chain("hedger input age for the closed MCKA feed is not stale", ages.get("MCKA"), 0);
    ages.set("ETH", 0);
    const rw = await runHedgeCycle(wk.cycleDeps);
    const nm = rw.names.MCKA!;
    row.chain("weekend: the 24/7 mock hedges MCKA while its feed is closed", nm.action, "traded");
    const expW = await readGov<readonly [bigint, bigint, bigint]>(ctx, "exposure", [mcka.market]);
    const dw = wadToUsdg(expW[0]) - (await wvenue.netPositionUsd("MCKA"));
    row.chainTrue("weekend delta residual inside the band", (dw < 0n ? -dw : dw) <= nm.bandUsd, `residual ${dw} band ${nm.bandUsd}`);
    const pw = await runHedgePosts(wk.postDeps, new Set(["MCKA", "ETH"]));
    row.chain("weekend post for MCKA", pw.MCKA?.action, "posted");
    // leave the Governor un-stale for the next rows (ETH is hedged in the same kit)
    row.chain("hedgeStale is false at the end of the row", await readGov<boolean>(ctx, "hedgeStale"), false);
    void IODMinterAbi; void encodeFunctionData; void volKey; void postVol; void keyOf; void walletFor; void privateKeyToAccount; void normOf;
    })(); } finally { await hold.fn?.().catch(() => undefined); } // leave the Governor un-stale for the rows that follow
  },
};

const G06: Flow = {
  id: "G06", area: "services", kind: "success",
  name: "hedger refuses stale inputs: a stale mark and a disagreeing indexed book both hold the name unhedged with no trade, and the venue is untouched until the inputs are fresh",
  async run(row, ctx) {
    const hold: { fn?: () => Promise<void> } = {};
    try { await (async () => {
    stopService("hedger");
    await ensureHedgerRole(ctx, row);
    await ethBook(ctx, row);
    const venue = new MockVenue({ name: "mock", marks: { ETH: await markWad(ctx, "ETH") }, alwaysOpen: true });
    const ages = new Map<string, number>();
    const kit = hedgerKit(ctx, row, [ethMarket], venue, ages);
    hold.fn = () => refreshHedges(ctx, row);
    await kit.sync();
    ages.set("ETH", 3_600_000); // the oracle mark is an hour old; the limit is 15 minutes
    const r1 = await runHedgeCycle(kit.cycleDeps);
    row.chain("stale mark: action", r1.names.ETH?.action, "hold");
    row.chain("stale mark: reason", r1.names.ETH?.reason, "stale_inputs");
    row.chain("stale mark: the venue was never traded", venue.calls.trade, 0);
    row.chainTrue("stale mark: the name is reported unhedged", r1.unhedged.ETH !== undefined, JSON.stringify(r1.unhedged));
    ages.set("ETH", Number.POSITIVE_INFINITY); // the bin reports an unfresh guard read as an infinite age
    const r2 = await runHedgeCycle(kit.cycleDeps);
    row.chain("unfresh mark: reason", r2.names.ETH?.reason, "stale_inputs");
    row.chain("unfresh mark: no trade", venue.calls.trade, 0);
    ages.set("ETH", 0);
    // the indexed book disagrees with the chain by far more than the tolerance: refuse (R3) rather than trade on either
    kit.indexed.override.set("ETH", { delta: 0n });
    const r3 = await runHedgeCycle(kit.cycleDeps);
    row.chain("disagreeing indexed book: reason", r3.names.ETH?.reason, "disagree_with_chain");
    row.chain("disagreeing indexed book: no trade", venue.calls.trade, 0);
    kit.indexed.override.delete("ETH");
    const r4 = await runHedgeCycle(kit.cycleDeps);
    row.chain("fresh inputs: the hedger trades again", r4.names.ETH?.action, "traded");
    row.chainTrue("fresh inputs: a position exists", (await venue.netPositionUsd("ETH")) > 0n);
    // stale posting inputs: an unhealthy venue posts nothing and raises hedge_post_missed, it never posts a guess
    venue.setHealthy(false, "down");
    const missed = await runHedgePosts(kit.postDeps, new Set(["ETH"]));
    row.chain("unhealthy venue: the post is missed, not guessed", missed.ETH?.action, "missed");
    venue.setHealthy(true);
    })(); } finally { await hold.fn?.().catch(() => undefined); }
  },
};

const G07: Flow = {
  id: "G07", area: "services", kind: "success",
  name: "risk-sim nightly on the live fork book writes risk_runs, risk_scenario_results and risk_caps rows and recommends only",
  async run(row, ctx) {
    const py = `${import.meta.dir}/../../../../risk-sim/.venv/bin/risk-sim`;
    const q = sql();
    try {
      const url = `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:${5433 + Number(process.env.PORT_OFFSET ?? 0)}/od_fork`;
      const ledger = await q`select count(*)::int as n from governor_ledger`;
      row.chainTrue("the indexed Governor book has rows (the indexer ran)", Number(ledger[0]!.n) > 0, ledger[0]);
      // the chain clock is days ahead of the vol-engine's last post: post sigma now and wait until the indexer has it, or the run is stale_inputs
      await freshen(ctx, ["ETH", "BTC", "MCKR", "MCKA"]);
      const cut = new Date(Number(await nowTs(ctx)) * 1000 - 3_600_000);
      await pollApi(() => q`select count(*)::int as n from vol_posts where gear_or_underlying = 'ETH' and ts >= ${cut}`, (r) => Number(r[0]!.n) > 0, 150_000).catch(() => undefined);
      const before = Number((await q`select count(*)::int as n from risk_runs`)[0]!.n);
      const chainNow = String(await nowTs(ctx)); // the fork's clock runs ahead of the wall clock: risk-sim's own "now" is the chain time
      const p = Bun.spawnSync([py, "run", "--nightly", "--now", chainNow], { env: { ...process.env, DATABASE_URL: url, RISK_WRITE_DATABASE_URL: url, RISK_MAX_BOOK_AGE_SECONDS: "86400000" }, stdout: "pipe", stderr: "pipe", timeout: 240_000 });
      row.note(`risk-sim exit ${p.exitCode}: ${p.stdout.toString().split("\n").slice(-4).join(" | ").slice(0, 300)}${p.stderr.toString().slice(-200)}`);
      row.chain("risk-sim exits 0", p.exitCode, 0);
      const after = Number((await q`select count(*)::int as n from risk_runs`)[0]!.n);
      row.chain("one risk_runs row written", after - before, 1);
      const sc = Number((await q`select count(*)::int as n from risk_scenario_results`)[0]!.n);
      const caps = Number((await q`select count(*)::int as n from risk_caps`)[0]!.n);
      row.chainTrue("scenario results written (eight scenarios)", sc >= 8, sc);
      row.chainTrue("cap recommendations written", caps > 0, caps);
    } finally { await q.end({ timeout: 2 }); }
  },
};

const G08: Flow = {
  id: "G08", area: "services", kind: "success",
  name: "crank toll job: stale gears are all accrued by the live crank, the batch size adapts to a gas refusal, one bad gear does not block the others",
  async run(row, ctx) {
    try { await (async () => {
    const reg = (await import("../../../src/abi")).IODGearRegistryAbi;
    const n = Number((await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: reg, functionName: "gearCount" })) as bigint);
    const ids = (await Promise.all(Array.from({ length: n }, (_, i) => ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: reg, functionName: "gearIdAt", args: [BigInt(i)] })))) as `0x${string}`[];
    const supplies = await Promise.all(ids.map(async (id) => {
      const cfg = (await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: reg, functionName: "gear", args: [id] })) as { token: `0x${string}` };
      return (await ctx.pub.readContract({ address: cfg.token, abi: [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "totalSupply" })) as bigint;
    }));
    const live = ids.filter((_, i) => supplies[i]! > 0n);
    row.chainTrue("there are gears with supply to accrue", live.length >= 2, live.length);
    // part 1: the in-process job body with an injected gas refusal and one bad gear id
    const crank = walletFor("crank");
    // IODMinter.accrueMany skips an unknown id instead of reverting, so "one bad gear" is injected: the tx wrapper refuses any batch
    // that contains this id, exactly as a gear whose accrual reverts would
    const bogus = live[0]!;
    const sizes: number[] = [];
    let injectBad = true;
    const tx = {
      async submit(t: { to: `0x${string}`; data: `0x${string}`; label: string }) {
        const decoded = t.data;
        if (injectBad && decoded.toLowerCase().includes(bogus.slice(2).toLowerCase())) throw new Error("execution reverted: injected bad gear");
        sizes.push((decoded.length - 2 - 8 - 128) / 64); // selector, offset, length words, then 32-byte ids
        const hash = await crank.sendTransaction({ to: t.to, data: decoded, gas: 4_000_000n, chain: null, account: crank.account! } as never);
        const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("execution reverted");
        return { simulated: false, hash, receipt, gasUsed: receipt.gasUsed };
      },
    };
    const tuner = createGasTuner({ initialBatch: 8, maxBatch: 45, gasTarget: 8_000_000, minBatch: 1 });
    await ctx.test.increaseTime({ seconds: 600 }); await ctx.test.mine({ blocks: 1 });
    const before = await Promise.all(live.map(async (id) => (await normOf(ctx, id)).lastAccrual));
    void before;
    const out = await accrueInBatches({ tx: tx as never, deployment: { contracts: { ODMinter: ctx.c.ODMinter! } } as never, logger: silent as never }, live, 8, tuner);
    injectBad = false;
    row.chainTrue("the bad gear is reported failed with its id", out.failed.length === 1 && out.failed[0]!.id === bogus, JSON.stringify(out.failed));
    row.chain("every other gear with supply accrued despite the bad one", out.accrued.length, live.length - 1);
    const after = await Promise.all(live.map(async (id) => (await normOf(ctx, id)).lastAccrual));
    row.chainTrue("every accrued gear's lastAccrual moved forward, the bad one did not", after.every((a, i) => (i === 0 ? a === before[i]! : a > before[i]!)), `${before} -> ${after}`);
    row.chainTrue("the batch was split to isolate the bad gear (more than one transaction)", out.transactions > 1, `${out.transactions} tx, sizes ${sizes}`);
    // adaptivity: a gas refusal on large batches shrinks the tuner's batch
    const tuner2 = createGasTuner({ initialBatch: 8, maxBatch: 45, gasTarget: 8_000_000, minBatch: 1 });
    const startBatch = tuner2.choose(30_000_000).batch;
    const tx2 = { async submit(t: { data: `0x${string}`; to: `0x${string}`; label: string }) {
      const k = (t.data.length - 2 - 8 - 128) / 64;
      if (k > 2) throw new Error("exceeds block gas limit");
      return tx.submit(t);
    } };
    await ctx.test.increaseTime({ seconds: 600 }); await ctx.test.mine({ blocks: 1 });
    const out2 = await accrueInBatches({ tx: tx2 as never, deployment: { contracts: { ODMinter: ctx.c.ODMinter! } } as never, logger: silent as never }, live, 8, tuner2);
    row.chain("a gas refusal still accrues every gear (batches halved)", out2.accrued.length, live.length);
    row.chainTrue("after the refusal every batch that went through was at most 2 gears", out2.batches.length > 0 && out2.batches.every((k) => k <= 2), `batches ${out2.batches}`);
    row.note(`tuner batch before ${startBatch}, after the refused pass ${tuner2.choose(30_000_000).batch} (it re-grows on success; the in-pass halving is what is asserted)`);
    // part 2: the live crank job accrues stale gears on its own (max age 3600 s, job every 5 minutes)
    await ctx.test.increaseTime({ seconds: 3700 }); await ctx.test.mine({ blocks: 1 });
    await freshen(ctx, ["ETH"]);
    const t0 = await nowTs(ctx);
    const stale = await Promise.all(live.map(async (id) => (await normOf(ctx, id)).lastAccrual));
    row.chainTrue("every gear is now older than the crank's max age", stale.every((a) => t0 - a > 3600n), `${stale}`);
    const deadline = Date.now() + 8 * 60_000;
    let moved: number = 0;
    while (Date.now() < deadline) {
      const now = await Promise.all(live.map(async (id) => (await normOf(ctx, id)).lastAccrual));
      moved = now.filter((a, i) => a > stale[i]!).length;
      if (moved === live.length) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    row.chain("the live crank accrued every gear with supply", moved, live.length);
    void encodeFunctionData; void IODMinterAbi;
    })(); } finally { await refreshHedges(ctx, row).catch(() => undefined); } // these rows warp: keep the Governor's hedge fresh for the rows after
  },
};

const G09: Flow = {
  id: "G09", area: "services", kind: "success",
  name: "vol-engine (live service): posted sigma is accepted by the oracle, a step over 25 percent is ramped by the engine and refused by the contract, and a stale input only warns and posts nothing",
  async run(row, ctx) {
    try { await (async () => {
    const vol = ctx.c.ODVolOracle!;
    const market = volKey("ETH");
    const read = async () => (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "read", args: [market] })) as { postedAt: bigint; sigmaBps: bigint; validUntil: bigint };
    const r0 = await read();
    row.chainTrue("the service's post is on the oracle (postedAt set)", r0.postedAt > 0n, r0.postedAt);
    row.chainTrue("sigma is inside the oracle's bounds", await (async () => { const [lo, hi] = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "bounds", args: [market] })) as [bigint, bigint]; return r0.sigmaBps >= lo && r0.sigmaBps <= hi; })(), r0.sigmaBps);
    const log = (await Bun.file(`${process.env.FORK_DIR ?? `${process.env.HOME}/.overdrive/fork`}/logs/vol-engine.log`).text());
    row.chainTrue("the engine logged ETH accepted", /ETH sigma=\d+ bps nonce=\d+ accepted/.test(log));
    const nonce = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "lastNonce", args: [market] })) as bigint;
    row.chainTrue("the oracle nonce advanced with the accepted post", nonce >= 1n, nonce);
    // a step too large: the engine's guard ramps it; the contract refuses an un-ramped one
    const venvPy = `${import.meta.dir}/../../../../vol-engine/.venv/bin/python`;
    const prior = Number(r0.sigmaBps);
    const g = Bun.spawnSync([venvPy, "-I", "-c", `from vol_engine.guard import clamp_step; print(clamp_step(${prior * 3}, ${prior}, 500, 20000))`], { env: { ...process.env, PYTHONPATH: `${import.meta.dir}/../../../../vol-engine/src` }, stdout: "pipe", stderr: "pipe" });
    const outG = g.stdout.toString().trim();
    row.note(`engine guard for a 3x target against prior ${prior}: ${outG}`);
    const rampedTo = Number(/\((\d+),/.exec(outG)?.[1] ?? 0);
    row.chain("the engine ramps a 3x target to +25 percent of the prior", rampedTo, prior + Math.floor(prior / 4));
    row.chainTrue("the engine flags it ramped", /ramped/.test(outG), outG);
    const [floor, ceiling] = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "bounds", args: [market] })) as [bigint, bigint];
    const bad = Math.min(Number(ceiling), prior * 2);
    if (bad > prior + Math.floor(prior / 4) + 1 && BigInt(bad) >= floor) {
      await ctx.test.increaseTime({ seconds: 40 }); await ctx.test.mine({ blocks: 1 });
      const t = await nowTs(ctx);
      const post = { market, sigmaBps: BigInt(bad), buyBlockFrom: 0n, buyBlockTo: 0n, validUntil: t + 7000n, nonce: nonce + 1n };
      const digest = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "hashPost", args: [post] })) as `0x${string}`;
      const sig = await privateKeyToAccount(keyOf("volSigner")).sign({ hash: digest });
      await row.expectRevert("the contract refuses an un-ramped step over 25 percent", "volSender", { address: vol, abi: IODVolOracleAbi as never, functionName: "post", args: [post, sig] }, ["StepTooLarge", "StepTooBig", "BadStep", "JumpTooLarge", "SigmaStep"]);
    } else row.note("ceiling too close to the prior sigma to build an over-25-percent step; the engine side is proven above");
    // stale inputs: the chain clock jumps past the price age limit; a one-shot pass (no send) warns and posts nothing
    await ctx.test.increaseTime({ seconds: 3 * 86_400 }); await ctx.test.mine({ blocks: 1 });
    const env = { ...process.env, ...Object.fromEntries((await Bun.file(`${process.env.FORK_DIR}/env/vol-engine.env`).text()).split("\n").filter((l) => /^[A-Z_]+=/.test(l) && !/KEY|PASS/.test(l.split("=")[0]!) ).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), VOL_SEND: "0" };
    const nonceBefore = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "lastNonce", args: [market] })) as bigint;
    const p = Bun.spawnSync([`${import.meta.dir}/../../../../vol-engine/.venv/bin/vol-engine`, "post", "--once"], { env: { ...env, VOL_SIGNER_KEYSTORE: `${process.env.FORK_DIR}/keys/volSigner.json`, VOL_SIGNER_KEYSTORE_PASSWORD_FILE: `${process.env.FORK_DIR}/keys/password`, VOL_SENDER_KEYSTORE: `${process.env.FORK_DIR}/keys/volSender.json`, VOL_SENDER_KEYSTORE_PASSWORD_FILE: `${process.env.FORK_DIR}/keys/password` }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const text = `${p.stdout.toString()}\n${p.stderr.toString()}`;
    row.note(`vol-engine --once after a 3 day jump (no send): exit ${p.exitCode}; ${text.replace(/\s+/g, " ").slice(-400)}`);
    row.chain("a stale pass still exits 0 (it warns, never crashes)", p.exitCode, 0);
    row.chainTrue("the pass warned about stale prices", /stale_prices|stale/i.test(text), text.slice(-300));
    row.chain("a stale pass posts nothing on chain", (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "lastNonce", args: [market] })) as bigint, nonceBefore);
    await freshen(ctx, ["ETH", "BTC"]);
    })(); } finally { await refreshHedges(ctx, row).catch(() => undefined); } // these rows warp: keep the Governor's hedge fresh for the rows after
  },
};

export const flows: Flow[] = [G05, G06, G07, G08, G09];
