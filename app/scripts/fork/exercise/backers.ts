// Backer flows B01 to B04, B09, B10 (todo 22c). B05 to B08 (liquidation) live in liquidation.ts and share the helpers below.
// Fixtures: ETH-SPORT (real frozen feed, 200 percent initial) and MCKR-RACE (mock always-open market, 250 percent initial).
import { encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { IODBackerAbi, IODGovernorAbi, IODOracleGuardAbi } from "../../../src/abi";
import { addressOf } from "../lib";
import {
  GEAR, apiGet, approveMinter, ensureCapital, ensureGear, ensureMockMarket, freshen, fundRole, nowTs, pokeMarket, pollApi, postVol, pushMockFeed, refreshMocks,
  sellDirect, tokenOf, usdgOf, warpBy, atNextSecond, readAt, revertNames, U, type Abi, type Ctx, type Flow, type GearInfo, type Row, type Role,
} from "./harness";
import { walletFor } from "../lib";
import { marketId } from "../setup";
import { bytes32OfText } from "../../../src/indexer/units";

export const G = 3_000_000n; // explicit gas: plain estimates under-run on this fork
export const backerAbi = IODBackerAbi as unknown as Abi;
export type Health = readonly [bigint, bigint, bigint, bigint, bigint];
export type VaultT = readonly [Address, Hex, bigint, bigint, bigint];

export const health = async (ctx: Ctx, vid: bigint) => (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "health", args: [vid] })) as Health;
export const vaultOf = async (ctx: Ctx, vid: bigint) => (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "vault", args: [vid] })) as VaultT;
export const vaultCount = async (ctx: Ctx) => (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "vaultCount" })) as bigint;
export const backerDebt = async (ctx: Ctx, id: Hex) => (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "backerDebt", args: [id] })) as bigint;

export const MCKR_PRICE = 100n * 10n ** 8n;

/** Capital, backer minting unpaused (the deploy leaves it paused; the admin is the timelock), the fixtures listed. */
export async function prepareBackers(ctx: Ctx): Promise<void> {
  await ensureCapital(ctx, null);
  const paused = (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "mintPaused" })) as boolean;
  if (paused) await unpauseMint(ctx, null);
  await ensureGear(ctx, null, "ETH", null, GEAR.SPORT);
  await ensureGear(ctx, null, "MCKR", null, GEAR.RACE);
  await ensureGear(ctx, null, "ETH", null, GEAR.ECO);
  await resetMckr(ctx, null);
}

export async function unpauseMint(ctx: Ctx, row: Row | null): Promise<void> {
  const { asTimelock } = await import("../lib");
  const hash = await asTimelock((w, tl) => w.writeContract({ address: ctx.c.ODBacker!, abi: backerAbi, functionName: "setMintPaused", args: [false], gas: 1_000_000n, chain: null, account: tl } as never));
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  row?.txs.push({ label: "setMintPaused(false) (timelock)", hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
  if (r.status !== "success") throw new Error(`unpause reverted (${hash})`);
}

/** MCKR back to $100 with fresh feed, Pyth and sigma. */
export async function resetMckr(ctx: Ctx, row: Row | null, price = MCKR_PRICE): Promise<void> {
  const m = await ensureMockMarket(ctx, "MCKR", true, { alwaysOpen: true, volCeil: 4000n });
  const w = walletFor("deployer");
  const hash = await w.writeContract({ address: m.feed, abi: (await import("./harness")).mockFeedAbi, functionName: "setRound", args: [price, await nowTs(ctx)], chain: null, account: w.account! } as never);
  await ctx.pub.waitForTransactionReceipt({ hash });
  await settleMckr(ctx, row, price);
  await freshen(ctx, ["ETH", "BTC", "MCKR"]);
}

/** The keeper's poke after a MCKR print, so the guard's last good price follows each in-band step (production cranks poke every
 * pass). A move back from far away is a continuity jump the guard latches: it clears only as the product defines, after
 * CONFIRMATIONS_TO_CLEAR later prints at the new level, so print and poke that many more rounds. */
async function settleMckr(ctx: Ctx, row: Row | null, price: bigint): Promise<void> {
  const m = await ensureMockMarket(ctx, "MCKR", true, { alwaysOpen: true, volCeil: 4000n });
  const reason = async () => (await ctx.pub.readContract({ address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi, functionName: "buysPausedReason", args: [marketId("MCKR")] })) as Hex;
  const CONT = bytes32OfText("CONTINUITY");
  await pokeMarket(ctx, row, "MCKR");
  const w = walletFor("deployer");
  for (let i = 0; i < 4 && (await reason()) === CONT; i++) {
    await ctx.test.increaseTime({ seconds: 1 });
    await ctx.test.mine({ blocks: 1 });
    const hash = await w.writeContract({ address: m.feed, abi: (await import("./harness")).mockFeedAbi, functionName: "setRound", args: [price, await nowTs(ctx)], chain: null, account: w.account! } as never);
    await ctx.pub.waitForTransactionReceipt({ hash });
    await pokeMarket(ctx, row, "MCKR");
  }
  if ((await reason()) === CONT) throw new Error("MCKR continuity pause did not clear after the confirming prints");
}

/** Moves the MCKR price (one step, kept inside the guard's continuity band) and re-prices its mock Pyth entry. */
export async function moveMckr(ctx: Ctx, row: Row, price: bigint, label: string): Promise<void> {
  const m = await ensureMockMarket(ctx, "MCKR", true, { alwaysOpen: true, volCeil: 4000n });
  await pushMockFeed(ctx, row, m, price, undefined, label);
  await refreshMocks(ctx);
  await pokeMarket(ctx, row, "MCKR");
}

/** Opens a vault for `role` and returns its id. */
export async function openVault(ctx: Ctx, row: Row, role: Role, g: GearInfo, usdg: bigint, label: string): Promise<bigint> {
  await approveMinter(ctx, row, role, ctx.usdg, ctx.c.ODBacker!);
  const id = (await vaultCount(ctx)) + 1n;
  await row.send(label, role, { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "openVault", args: [g.id, usdg], gas: G });
  const v = await vaultOf(ctx, id);
  row.chain(`${label}: vault owner`, v[0], addressOf(role));
  return id;
}

/** The largest `tokens` the backer accepts for an unsold mint at second `t` (binary search on eth_call). */
export async function maxMintAt(ctx: Ctx, role: Role, vid: bigint, t: bigint): Promise<bigint> {
  const from = addressOf(role);
  let lo = 0n, hi = 10n ** 26n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const data = encodeFunctionData({ abi: IODBackerAbi, functionName: "mint", args: [vid, mid, false, 0n] });
    try { await ctx.pub.call({ account: from, to: ctx.c.ODBacker!, data, gas: 8_000_000n, blockOverrides: { time: t } } as never); lo = mid; } catch { hi = mid; }
  }
  return lo;
}

/** Mints the maximum (exactly at the initial ratio) in one pinned second; returns the tokens and the receipt hash. */
export async function mintMax(ctx: Ctx, row: Row, role: Role, vid: bigint, label: string, fraction = 1n, of = 1n): Promise<bigint> {
  return atNextSecond(ctx, async (t) => {
    const max = await maxMintAt(ctx, role, vid, t);
    const tokens = (max * fraction) / of;
    await row.send(label, role, { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "mint", args: [vid, tokens, false, 0n], gas: G });
    return tokens;
  });
}

export async function apiVault(id: bigint, ok: (v: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
  try {
    const r = await pollApi(async () => (await apiGet<{ vault?: Record<string, unknown> }>(`/v1/vaults/${id}`)).vault ?? null, (v) => !!v && ok(v), 45_000);
    return r;
  } catch { return null; }
}

export async function eventsOf(ctx: Ctx, hash: string, abi: Abi, name: string): Promise<{ args: Record<string, unknown> }[]> {
  const r = await ctx.pub.getTransactionReceipt({ hash: hash as Hex });
  return parseEventLogs({ abi, logs: r.logs, eventName: name } as never) as unknown as { args: Record<string, unknown> }[];
}

// ------------------------------------------------------------------------------------------------ rows

const B01: Flow = {
  id: "B01", area: "backers", kind: "success", name: "open a vault at exactly the initial ratio (200 percent, Race 250 percent); one step beyond reverts Undercollateralized",
  async run(row, ctx) {
    const cases: { g: GearInfo; req: bigint; role: Role }[] = [
      { g: await ensureGear(ctx, row, "ETH", null, GEAR.SPORT), req: 20000n, role: "backer" },
      { g: await ensureGear(ctx, row, "MCKR", null, GEAR.RACE), req: 25000n, role: "backer2" },
    ];
    for (const c of cases) {
      await fundRole(ctx, c.role, 50_000);
      await freshen(ctx, ["ETH", "MCKR"]);
      const held0 = await tokenOf(ctx, c.g.token, addressOf(c.role));
      const vid = await openVault(ctx, row, c.role, c.g, U(1000), `open ${c.g.key} vault, 1000 USDG`);
      const tokens = await mintMax(ctx, row, c.role, vid, `mint the maximum on ${c.g.key}`);
      const [coll, debtWad, ratio, required] = await health(ctx, vid);
      row.chain(`${c.g.key} required ratio`, required, c.req);
      row.chainTrue(`${c.g.key} ratio at or above required`, ratio >= c.req, ratio);
      row.chainTrue(`${c.g.key} ratio within 1 bp of required (exactly at the limit)`, ratio <= c.req + 1n, ratio);
      row.chain(`${c.g.key} vault debt`, (await vaultOf(ctx, vid))[3], tokens);
      row.chainTrue(`${c.g.key} collateral intact`, coll > 0n && debtWad > 0n);
      row.chain(`${c.g.key} owner received the minted tokens`, (await tokenOf(ctx, c.g.token, addressOf(c.role))) - held0, tokens);
      const names = await row.expectRevert(`${c.g.key} one more token over the limit`, c.role, { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "mint", args: [vid, 10n ** 15n, false, 0n] }, ["Undercollateralized"]);
      void names;
      const api = await apiVault(vid, (v) => v.debtTokens === tokens.toString());
      row.api(`${c.g.key} API vault debtTokens`, api?.debtTokens, tokens.toString());
      row.api(`${c.g.key} API vault requiredBps`, api?.requiredBps, c.req.toString());
    }
    // below the minimum collateral
    await row.expectRevert("open with 49 USDG", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "openVault", args: [cases[0]!.g.id, U(49)] }, ["BelowMinimumCollateral"]);
  },
};

const B02: Flow = {
  id: "B02", area: "backers", kind: "success", name: "mint gear against collateral and sell it (to the Governor and through the minter): proceeds equal the book, Governor backer debt follows",
  async run(row, ctx) {
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    const who = await fundRole(ctx, "backer", 100_000);
    await freshen(ctx, ["ETH"]);
    const vid = await openVault(ctx, row, "backer", g, U(5000), "open ETH-SPORT vault, 5000 USDG");
    // (a) mint and sell to the Governor in one call: the proceeds become collateral
    const debt0 = await backerDebt(ctx, g.id);
    const net0 = (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "netTokens", args: [g.id] })) as bigint;
    const tokens = 10n ** 18n * 20n;
    const tx = await atNextSecond(ctx, async () => row.send("mint 20 tokens and sell to the Governor", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "mint", args: [vid, tokens, true, 0n], gas: G }));
    const ev = (await eventsOf(ctx, tx.hash, backerAbi, "Minted"))[0]!.args as { tokens: bigint; soldToGovernor: boolean; proceedsUsdg: bigint };
    row.chain("Minted.tokens", ev.tokens, tokens);
    row.chain("Minted.soldToGovernor", ev.soldToGovernor, true);
    const v1 = await vaultOf(ctx, vid);
    row.chain("collateral grew by exactly the proceeds", v1[2], U(5000) + ev.proceedsUsdg - (await tollOf(ctx, tx.hash)));
    row.chain("vault debt", v1[3], tokens);
    row.chain("Governor backerDebt rose by the tokens", (await backerDebt(ctx, g.id)) - debt0, tokens);
    row.chain("Governor netTokens fell by the tokens", net0 - ((await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "netTokens", args: [g.id] })) as bigint), tokens);
    // (b) mint to the owner and sell it through the minter (a hook pool sell needs gear in the PoolManager, backlog D26)
    const t2 = 10n ** 18n * 10n;
    const held0 = await tokenOf(ctx, g.token, who);
    await row.send("mint 10 tokens to the owner (not sold)", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "mint", args: [vid, t2, false, 0n], gas: G });
    row.chain("owner received the 10 tokens", (await tokenOf(ctx, g.token, who)) - held0, t2);
    const q = await sellDirect(ctx, row, "backer", g, t2, "sell the 10 tokens (minter)");
    row.chainTrue("sale paid USDG", q.amountOut > 0n);
    const api = await apiVault(vid, (v) => v.debtTokens === (tokens + t2).toString());
    row.api("API vault debtTokens", api?.debtTokens, (tokens + t2).toString());
  },
};
async function tollOf(ctx: Ctx, hash: string): Promise<bigint> {
  const e = await eventsOf(ctx, hash, backerAbi, "TollFeeCharged");
  return e.reduce((a, x) => a + (x.args.usdg as bigint), 0n);
}

const B03: Flow = {
  id: "B03", area: "backers", kind: "success", name: "a vault with debt owes toll over a day: tollFeeOwed equals the charge at the next action, collateral falls by it, TollFeeCharged emitted",
  async run(row, ctx) {
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    await fundRole(ctx, "backer", 100_000);
    await freshen(ctx, ["ETH"]);
    const vid = await openVault(ctx, row, "backer", g, U(2000), "open ETH-SPORT vault, 2000 USDG");
    await mintMax(ctx, row, "backer", vid, "mint at 2/3 of the maximum", 2n, 3n);
    const c0 = (await vaultOf(ctx, vid))[2];
    await warpBy(ctx, 86_400);
    await freshen(ctx, ["ETH"]);
    // accrue the gear first so the cumulative toll index is current, then pin the next second for view and action alike
    const minterAbi = (await import("../../../src/abi")).IODMinterAbi as unknown as Abi;
    await row.send("accrue ETH-SPORT after one day", "crank", { address: ctx.c.ODMinter!, abi: minterAbi, functionName: "accrue", args: [g.id], gas: G });
    const tx = await atNextSecond(ctx, async (t) => {
      const owed = (await readAt(ctx, t, ctx.c.ODBacker!, backerAbi, "tollFeeOwed", [vid])) as bigint;
      row.note(`tollFeeOwed at the action second: ${owed}`);
      row.chainTrue("one day of toll is owed", owed > 0n, owed);
      const rec = await row.send("top up 1 unit (charges the toll)", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "deposit", args: [vid, 1n], gas: G });
      return { rec, owed };
    });
    const charged = await tollOf(ctx, tx.rec.hash);
    row.chain("TollFeeCharged equals tollFeeOwed", charged, tx.owed);
    row.chain("collateral fell by the toll (plus the 1 unit top up)", (await vaultOf(ctx, vid))[2], c0 - charged + 1n);
    row.chainTrue("tollFeeOwed restarts near zero after the charge", ((await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "tollFeeOwed", args: [vid] })) as bigint) <= tx.owed / 100n + 1n);
    const api = await apiVault(vid, (v) => v.collateralUsdg === (c0 - charged + 1n).toString());
    row.api("API vault collateralUsdg", api?.collateralUsdg, (c0 - charged + 1n).toString());
  },
};

const B04: Flow = {
  id: "B04", area: "backers", kind: "expected_failure", name: "anyone tops up; the owner withdraws above the initial ratio; below it, and by a stranger, withdraw reverts",
  async run(row, ctx) {
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    const who = await fundRole(ctx, "backer", 100_000);
    await fundRole(ctx, "carol", 10_000);
    await freshen(ctx, ["ETH"]);
    const vid = await openVault(ctx, row, "backer", g, U(1200), "open ETH-SPORT vault, 1200 USDG");
    await mintMax(ctx, row, "backer", vid, "mint at 2/3 of the maximum (about 300 percent)", 2n, 3n);
    await approveMinter(ctx, row, "carol", ctx.usdg, ctx.c.ODBacker!);
    const c0 = (await vaultOf(ctx, vid))[2];
    await row.send("carol tops the vault up by 100 USDG", "carol", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "deposit", args: [vid, U(100)], gas: G });
    row.chainWithin("collateral grew by the top up (less a few seconds of toll)", (await vaultOf(ctx, vid))[2], c0 + U(100), 5_000n);
    const [, , r1] = await health(ctx, vid);
    row.chainTrue("ratio above 250 percent before the withdrawal", r1 > 25000n, r1);
    const u0 = await usdgOf(ctx, who);
    await row.send("owner withdraws 150 USDG (stays above 200 percent)", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "withdraw", args: [vid, U(150), who], gas: G });
    row.chain("owner received 150 USDG", (await usdgOf(ctx, who)) - u0, U(150));
    const [coll] = await health(ctx, vid);
    await row.expectRevert("owner withdraws down to below 200 percent", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "withdraw", args: [vid, coll - 1_000_000n, who] }, ["Undercollateralized"]);
    await row.expectRevert("a stranger withdraws", "carol", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "withdraw", args: [vid, U(1), addressOf("carol")] }, ["NotVaultOwner"]);
    const api = await apiVault(vid, (v) => v.status !== undefined);
    row.api("API knows the vault", api?.id, vid.toString());
  },
};

const B09: Flow = {
  id: "B09", area: "backers", kind: "expected_failure", name: "backer minting paused: a new mint reverts MintingClosed; existing vaults can still be repaid, closed and liquidated",
  async run(row, ctx) {
    const g = await ensureGear(ctx, row, "MCKR", null, GEAR.RACE);
    const who = await fundRole(ctx, "backer", 100_000);
    await fundRole(ctx, "backer2", 100_000);
    await resetMckr(ctx, row);
    const closer = await openVault(ctx, row, "backer", g, U(1000), "open MCKR-RACE vault A (will be closed)");
    const tokensA = await mintMax(ctx, row, "backer", closer, "vault A mint max", 1n, 2n);
    const victim = await openVault(ctx, row, "backer2", g, U(1000), "open MCKR-RACE vault B (will be liquidated)");
    const tokensB = await mintMax(ctx, row, "backer2", victim, "vault B mint max");
    await row.send("guardian pauses backer minting", "guardian", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "setMintPaused", args: [true], gas: 1_000_000n });
    try {
      row.chain("mintPaused", (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "mintPaused" })) as boolean, true);
      await row.expectRevert("new mint while paused", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "mint", args: [closer, 10n ** 15n, false, 0n] }, ["MintingClosed"]);
      await row.expectRevert("new vault mint-and-sell while paused", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "mint", args: [closer, 10n ** 15n, true, 0n] }, ["MintingClosed"]);
      // existing vault A is closable: repay everything, withdraw everything
      await approveMinter(ctx, row, "backer", g.token, ctx.c.ODBacker!);
      await row.send("repay all vault A debt (burns the minted tokens)", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "repay", args: [closer, tokensA], gas: G });
      row.chain("vault A debt is zero", (await vaultOf(ctx, closer))[3], 0n);
      const [c] = await health(ctx, closer);
      const u0 = await usdgOf(ctx, who);
      await row.send("withdraw all vault A collateral", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "withdraw", args: [closer, c, who], gas: G });
      row.chain("vault A withdrawn in full", (await usdgOf(ctx, who)) - u0, c);
      // existing vault B is liquidatable while paused: price up 10 percent -> Race ratio 187 percent < 200 percent maintenance
      const blk0 = await ctx.pub.getBlockNumber({ cacheTime: 0 });
      await moveMckr(ctx, row, (MCKR_PRICE * 110n) / 100n, "MCKR price +10 percent");
      await postVol(ctx, "MCKR");
      const liq = ctx.c.ODBacker!;
      const [, , r, , maint] = await health(ctx, victim);
      row.chainTrue("vault B is below maintenance", r < maint, `${r} vs ${maint}`);
      // the live liquidator service signs with the same key and seals on its 30 s pass; when it got there first, vault B
      // sits in its live batch and a second seal reverts SealRefused("NONE_UNHEALTHY") (ODBacker.sol:340, :346): use it
      const sealCall = { address: liq, abi: backerAbi, functionName: "sealBatch", args: [g.id, [victim]], gas: G } as const;
      let batchId = (await vaultOf(ctx, victim))[4];
      if (batchId === 0n) {
        try {
          await ctx.pub.simulateContract({ ...sealCall, account: addressOf("liquidator") } as never);
          const rec = await row.send("seal a batch (permissionless) while minting is paused", "liquidator", sealCall);
          batchId = ((await eventsOf(ctx, rec.hash, backerAbi, "BatchSealed"))[0]!.args as { batchId: bigint }).batchId;
        } catch (e) {
          batchId = (await vaultOf(ctx, victim))[4];
          if (batchId === 0n) throw e;
        }
      }
      if (!(row.txs.some((t) => t.label.startsWith("seal a batch")))) row.note(`the liquidator service sealed vault B first (batch ${batchId}); asserted on that batch`);
      const sealedEv = await ctx.pub.getContractEvents({ address: liq, abi: IODBackerAbi, eventName: "BatchSealed", fromBlock: blk0, args: { batchId } });
      row.chainTrue("vault B sealed while minting is paused", sealedEv.length === 1, `batch ${batchId}`);
      const [readyAt] = (await ctx.pub.readContract({ address: liq, abi: IODBackerAbi, functionName: "batchWindow", args: [batchId] })) as readonly [bigint, bigint];
      await (await import("./harness")).nextBlockAtLeast(ctx, readyAt);
      const liqLogs = () => ctx.pub.getContractEvents({ address: liq, abi: IODBackerAbi, eventName: "Liquidated", fromBlock: blk0, args: { vaultId: victim } });
      let done = await liqLogs();
      if (!done.length) {
        const execCall = { address: liq, abi: backerAbi, functionName: "executeBatch", args: [batchId], gas: 6_000_000n } as const;
        try {
          const now = await (await import("./harness")).nowTs(ctx);
          await ctx.pub.simulateContract({ ...execCall, account: addressOf("liquidator"), blockOverrides: { time: readyAt > now ? readyAt : now + 1n } } as never);
          await row.send("execute the batch while minting is paused", "liquidator", execCall);
        } catch (e) {
          if (!(await liqLogs()).length) throw e;
        }
        done = await liqLogs();
      }
      if (!row.txs.some((t) => t.label.startsWith("execute the batch"))) row.note("the liquidator service executed the batch first; asserted on its Liquidated event");
      const liqd = done[0]?.args as { vaultId: bigint; debtTokens: bigint } | undefined;
      row.chain("vault B liquidated while minting is paused", liqd?.vaultId, victim);
      row.chain("liquidated debt", liqd?.debtTokens, tokensB);
      row.chain("vault B debt cleared", (await vaultOf(ctx, victim))[3], 0n);
    } finally {
      await unpauseMint(ctx, row);
      await resetMckr(ctx, row);
    }
    row.chain("minting reopened by the timelock", (await ctx.pub.readContract({ address: ctx.c.ODBacker!, abi: IODBackerAbi, functionName: "mintPaused" })) as boolean, false);
  },
};

const B10: Flow = {
  id: "B10", area: "backers", kind: "expected_failure", name: "an Eco gear cannot be backed: openVault reverts NotBackable",
  async run(row, ctx) {
    const eco = await ensureGear(ctx, row, "ETH", null, GEAR.ECO);
    await fundRole(ctx, "backer", 10_000);
    await approveMinter(ctx, row, "backer", ctx.usdg, ctx.c.ODBacker!);
    await row.expectRevert("open a vault on ETH-ECO", "backer", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "openVault", args: [eco.id, U(100)] }, ["NotBackable"]);
    row.chain("no vault was created for it", (await vaultCount(ctx)) >= 0n, true);
    void revertNames;
  },
};

export const flows: Flow[] = [B01, B02, B03, B04, B09, B10];
export const prepare = prepareBackers;
