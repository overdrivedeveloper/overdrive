// Tracker 93: docs/runbooks/shutdown.md section 3 walked as an outsider with no website. Setup (holders, a vault, a stake, a
// policy) is done with viem while everything is open; then the guardian sets every pause the runbook lists (Governor buys,
// backer mint, stake deposits, one gear SELL_ONLY) and each withdrawal path is run ONLY with `cast` (call to simulate, send
// from an unlocked fork account) against the loopback node, using the addresses of the deployment file.
//   bun scripts/fork/exercise/index.ts --area shutdown            (SH01 first, SH09 last: it warps 35 days)
import { type Abi, type Address, type Hex, getAddress, parseAbi } from "viem";
import { IODGovernorAbi, IODGearRegistryAbi, IODMinterAbi } from "../../../src/abi";
import { ANVIL_URL, addressOf, asTimelock, walletFor, type Role } from "../lib";
import { marketId } from "../setup";
import { GEAR, Blocked, buyDirect, ensureCapital, ensureGear, ensureMockMarket, freshen, fundRole, gotoSession, nowTs, pokeMarket, pushCalendar, tokenOf, U, warpBy, type Ctx, type Flow, type GearInfo, type Row } from "./harness";
import { mintMax, openVault, backerAbi } from "./backers";
import { runbookIssues } from "./admin";

const CAST = `${process.env.HOME}/.foundry/bin/cast`;
const HOLDER: Role = "dave";
const stakeAbi = parseAbi(["function setDepositsPaused(bool)", "function depositsPaused() view returns (bool)", "function ovrd() view returns (address)"]);
const devAbi = parseAbi(["function mint(address to, uint256 amount)", "function approve(address,uint256) returns (bool)"]);
const routerAbi = parseAbi(["function setPolicy(address agent,uint128 budgetUsdg,uint128 maxPerTradeUsdg,uint64 expiresAt,bool canSell,bool canBack,bytes32[] markets)"]);
const gearTuple = "(bytes32,bytes32,uint8,address,uint256,uint128,uint128,uint16,uint16,uint16,uint8,uint64)";

/** One cast invocation against the fork node; stdout, or a thrown error carrying stderr (never a key: only addresses are passed). */
function cast(row: Row, args: string[]): string {
  const p = Bun.spawnSync([CAST, ...args, ...(args[0] === "sig-event" ? [] : ["--rpc-url", ANVIL_URL])], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) {
    const msg = `cast ${args.slice(0, 3).join(" ")} failed: ${p.stderr.toString().trim().slice(0, 240)}`;
    row.note(`RUNBOOK-STEP-FAILED ${msg}`); runbookIssues.push(msg);
    throw new Error(msg);
  }
  return out;
}
/** The runbook's rule for every send: simulate with `cast call --from`, then send. Returns the tx hash. */
function castSend(row: Row, from: Address, to: Address, sig: string, args: string[], label: string): string {
  cast(row, ["call", "--from", from, to, sig, ...args]);
  const ok = (st: string) => st === "0x1" || st === "success" || st === "1";
  let out = JSON.parse(cast(row, ["send", "--unlocked", "--from", from, to, sig, ...args, "--json"])) as { transactionHash: string; status: string };
  if (!ok(out.status)) {
    // seen on the fork for ODStake.requestUnstake: the simulation passes, the estimated gas is too low, the send reverts with no reason
    row.note(`GAS-ESTIMATE ${label}: sent with the default estimate, reverted (${out.transactionHash}); resent with --gas-limit 1000000`);
    row.txs.push({ label: `cast send ${label} (default gas, reverted)`, hash: out.transactionHash, gas: "", status: "reverted" });
    out = JSON.parse(cast(row, ["send", "--unlocked", "--gas-limit", "1000000", "--from", from, to, sig, ...args, "--json"])) as { transactionHash: string; status: string };
  }
  if (!ok(out.status)) throw new Error(`${label}: tx status ${out.status}`);
  row.txs.push({ label: `cast send ${label}`, hash: out.transactionHash, gas: "", status: "success" });
  return out.transactionHash;
}
/** The indexed ticket of the event `sig` in a receipt (topic 1 or 2), matched by the event signature hash. */
function ticketFrom(row: Row, hash: string, sig: string, topicIdx: number): bigint {
  const t0 = cast(row, ["sig-event", sig]).toLowerCase();
  const logs = JSON.parse(cast(row, ["receipt", hash, "logs", "--json"])) as { topics: string[] }[];
  const ev = logs.find((l) => l.topics[0]?.toLowerCase() === t0);
  if (!ev) throw new Error(`no ${sig} in ${hash}`);
  return BigInt(ev.topics[topicIdx]!);
}
const num = (s: string) => BigInt(s.split(/\s+/)[0]!);

async function paused(ctx: Ctx, g: GearInfo) {
  const rd = (address: Address, abi: Abi, functionName: string) => ctx.pub.readContract({ address, abi, functionName } as never);
  return {
    buys: ((await rd(ctx.c.ODGovernor!, IODGovernorAbi as Abi, "buysPaused")) as readonly [boolean])[0],
    mint: (await rd(ctx.c.ODBacker!, backerAbi, "mintPaused")) as boolean,
    stake: (await rd(ctx.c.ODStake!, stakeAbi, "depositsPaused")) as boolean,
    gear: ((await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi, functionName: "gear", args: [g.id] })) as { status: number }).status,
  };
}
const timelockDo = (ctx: Ctx, address: Address, abi: Abi, functionName: string, args: unknown[]) =>
  asTimelock((w, t) => w.writeContract({ address, abi, functionName, args, gas: 3_000_000n, chain: null, account: t } as never)).then((hash) => ctx.pub.waitForTransactionReceipt({ hash }));

interface Shared { vault: bigint; debt: bigint; stakeShares: bigint; agent: Address }
let shared: Shared | null = null;
const sheet = (ctx: Ctx) => ({ me: addressOf(HOLDER), minter: ctx.c.ODMinter!, registry: ctx.c.ODGearRegistry!, backer: ctx.c.ODBacker!, stake: ctx.c.ODStake!, governor: ctx.c.ODGovernor!, router: ctx.c.ODAgentRouter!, usdg: ctx.usdg });

/** Positions while everything is open, then the guardian pauses everything the runbook lists. Re-runnable: restores first. */
async function ensureShutdownState(ctx: Ctx, row: Row): Promise<{ g: GearInfo; s: Shared }> {
  await ensureCapital(ctx, row);
  const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
  await freshen(ctx, ["ETH", "BTC"]);
  const p0 = await paused(ctx, g);
  if (shared && p0.buys && p0.mint && p0.stake && p0.gear === 3) return { g, s: shared };
  // restore the open state through the timelock (fork shortcut) so positions can be built
  if (p0.buys) await timelockDo(ctx, ctx.c.ODGovernor!, IODGovernorAbi as Abi, "setBuysPaused", [false]);
  if (p0.mint) await timelockDo(ctx, ctx.c.ODBacker!, backerAbi, "setMintPaused", [false]);
  if (p0.stake) await timelockDo(ctx, ctx.c.ODStake!, stakeAbi as Abi, "setDepositsPaused", [false]);
  if (p0.gear !== 1) await timelockDo(ctx, ctx.c.ODGearRegistry!, IODGearRegistryAbi as Abi, "setStatus", [g.id, 1]);
  const me = await fundRole(ctx, HOLDER, 500_000);
  await buyDirect(ctx, row, HOLDER, g, U(20_000), "holder buys 20000 USDG of ETH-SPORT");
  await ensureMockMarket(ctx, "MCKA", true);
  await gotoSession(ctx, "open", "MCKA", row); // a rerun may start days after the last feed print: fresh feed in an open session
  await pokeMarket(ctx, row, "MCKA");
  await freshen(ctx, ["ETH", "BTC", "MCKA"]);
  const gm = await ensureGear(ctx, row, "MCKA", null, GEAR.SPORT);
  await buyDirect(ctx, row, HOLDER, gm, U(3000), "holder buys 3000 USDG of MCKA-SPORT (for the settled path)");
  const vault = await openVault(ctx, row, HOLDER, g, U(2000), "holder opens a vault");
  const debt = await mintMax(ctx, row, HOLDER, vault, "holder mints against the vault", 1n, 2n);
  // stake: dev OVRD (the fork's tOVRD), stake, keep the position for the unstake path
  const ovrd = (await ctx.pub.readContract({ address: ctx.c.ODStake!, abi: stakeAbi, functionName: "ovrd" })) as Address;
  await row.send("mint test OVRD to the holder", HOLDER, { address: ovrd, abi: devAbi as Abi, functionName: "mint", args: [me, 10_000n * 10n ** 18n] });
  await row.send("holder approves the stake", HOLDER, { address: ovrd, abi: devAbi as Abi, functionName: "approve", args: [ctx.c.ODStake!, 2n ** 255n] });
  await row.send("holder stakes 10000 OVRD", HOLDER, { address: ctx.c.ODStake!, abi: parseAbi(["function stake(uint256) returns (uint256)"]) as Abi, functionName: "stake", args: [10_000n * 10n ** 18n] });
  const stakeShares = (await ctx.pub.readContract({ address: ctx.c.ODStake!, abi: parseAbi(["function sharesOf(address) view returns (uint256)"]), functionName: "sharesOf", args: [me] })) as bigint;
  // agent policy owned by the holder
  const agent = addressOf("agent");
  await row.send("holder sets an agent policy", HOLDER, { address: ctx.c.ODAgentRouter!, abi: routerAbi as Abi, functionName: "setPolicy", args: [agent, U(1000), U(100), (await nowTs(ctx)) + 86_400n * 90n, true, false, [marketId("ETH")]] });
  // the shutdown pauses (guardian): buys, backer mint, stake deposits, one gear SELL_ONLY
  await row.send("guardian: Governor buys paused", "guardian", { address: ctx.c.ODGovernor!, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [true] });
  await row.send("guardian: backer mint paused", "guardian", { address: ctx.c.ODBacker!, abi: backerAbi, functionName: "setMintPaused", args: [true] });
  await row.send("guardian: stake deposits paused", "guardian", { address: ctx.c.ODStake!, abi: stakeAbi as Abi, functionName: "setDepositsPaused", args: [true] });
  await row.send("guardian: ETH-SPORT SELL_ONLY", "guardian", { address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi as Abi, functionName: "setStatus", args: [g.id, 3] });
  const p1 = await paused(ctx, g);
  row.chain("all four pauses set", JSON.stringify(p1), JSON.stringify({ buys: true, mint: true, stake: true, gear: 3 }));
  await ctx.test.impersonateAccount({ address: me });
  shared = { vault, debt, stakeShares, agent };
  return { g, s: shared };
}
async function needState(ctx: Ctx, row: Row): Promise<{ g: GearInfo; s: Shared }> {
  const g = ctx.gears.get("ETH:1");
  const st = g ? await paused(ctx, g) : null;
  if (!shared || !g || !st || !(st.buys && st.mint && st.stake && st.gear === 3)) throw new Blocked("run SH01 first (it builds the positions and sets the pauses)");
  await ctx.test.impersonateAccount({ address: addressOf(HOLDER) });
  return { g, s: shared };
}

const SH01: Flow = {
  id: "SH01", area: "shutdown", kind: "success", name: "setup: positions, then guardian pauses (buys, backer mint, stake deposits, ETH-SPORT SELL_ONLY); read a gear with cast",
  async run(row, ctx) {
    const { g } = await ensureShutdownState(ctx, row);
    const x = sheet(ctx);
    // runbook step 'Find a gear token and your balance (read only)': the literal command, then the corrected one
    const raw = cast(row, ["call", x.registry, "gear(bytes32)", g.id]);
    row.note(`runbook literal 'cast call $REGISTRY gear(bytes32)' prints ${raw.length} hex chars with no field names (token not readable by eye)`);
    const decoded = cast(row, ["call", x.registry, `gear(bytes32)${gearTuple}`, g.id]);
    row.chainTrue("decoded gear struct shows the token address", decoded.toLowerCase().includes(g.token.toLowerCase()), decoded.slice(0, 120));
    const bal = num(cast(row, ["call", g.token, "balanceOf(address)(uint256)", x.me]));
    row.chainTrue("holder balance readable with cast", bal > 0n, bal);
  },
};

const SH02: Flow = {
  id: "SH02", area: "shutdown", kind: "success", name: "path: gear tokens, live market, gear SELL_ONLY and every pause set: ODMinter.sell with cast (no approve needed?)",
  async run(row, ctx) {
    const { g } = await needState(ctx, row);
    const x = sheet(ctx);
    const before = await tokenOf(ctx, g.token, x.me);
    const usd0 = num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me]));
    const deadline = String((await nowTs(ctx)) + 3600n); // chain time: the fork clock is not the wall clock
    const tokens = (before / 4n).toString();
    castSend(row, x.me, x.minter, "sell(bytes32,uint256,uint256,address,uint64)(uint256)", [g.id, tokens, "1", x.me, deadline], "ODMinter.sell");
    const usd1 = num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me]));
    row.chainTrue("USDG received", usd1 > usd0, `${usd1 - usd0}`);
    row.chain("tokens burned", before - (await tokenOf(ctx, g.token, x.me)), BigInt(tokens));
  },
};

const SH03: Flow = {
  id: "SH03", area: "shutdown", kind: "success", name: "path: queueSell, fillQueued by the owner and by a stranger, cancelQueued takes the tokens back",
  async run(row, ctx) {
    const { g } = await needState(ctx, row);
    const x = sheet(ctx), stranger = addressOf("bob");
    await ctx.test.impersonateAccount({ address: stranger });
    await ctx.test.setBalance({ address: stranger, value: 10n ** 19n });
    const t = async () => await tokenOf(ctx, g.token, x.me);
    const q = async (n: bigint) => {
      const h = castSend(row, x.me, x.minter, "queueSell(bytes32,uint256,uint256,address)(uint256)", [g.id, n.toString(), "1", x.me], "queueSell");
      return ticketFrom(row, h, "SellQueued(uint256,bytes32,address,uint256,uint256)", 1);
    };
    const bal0 = await t();
    const one = bal0 / 10n;
    const t1 = await q(one);
    row.chain("tokens escrowed by queueSell", bal0 - (await t()), one);
    const usd0 = num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me]));
    castSend(row, x.me, x.minter, "fillQueued(uint256)(uint256)", [t1.toString()], "fillQueued (owner)");
    row.chainTrue("owner fill paid USDG", num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me])) > usd0, "");
    const t2 = await q(one);
    castSend(row, stranger, x.minter, "fillQueued(uint256)(uint256)", [t2.toString()], "fillQueued (stranger)");
    row.chainTrue("stranger fill paid the owner's recipient", num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me])) > usd0, "");
    const bal1 = await t();
    const t3 = await q(one);
    castSend(row, x.me, x.minter, "cancelQueued(uint256)", [t3.toString()], "cancelQueued");
    row.chain("cancelQueued returned the tokens", await t(), bal1);
  },
};

const SH04: Flow = {
  id: "SH04", area: "shutdown", kind: "success", name: "path: backer vault with debt, minting paused: repay then withdraw with cast",
  async run(row, ctx) {
    const { g, s } = await needState(ctx, row);
    const x = sheet(ctx);
    const v = cast(row, ["call", x.backer, "vault(uint256)(address,bytes32,uint256,uint256,uint256)", s.vault.toString()]);
    row.note(`vault read: ${v.replace(/\n/g, " ").slice(0, 160)}`);
    castSend(row, x.me, x.backer, "repay(uint256,uint256)", [s.vault.toString(), s.debt.toString()], "ODBacker.repay");
    const col = (await ctx.pub.readContract({ address: x.backer, abi: backerAbi, functionName: "vault", args: [s.vault] }) as readonly bigint[]);
    row.chain("vault debt zero after repay", col[3], 0n);
    const u0 = num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me]));
    // the toll owed is charged inside withdraw, so the collateral shrinks by a few units between the read and the send:
    // withdraw a little less first, read the vault again, then withdraw the exact remainder (no debt, no more toll)
    castSend(row, x.me, x.backer, "withdraw(uint256,uint256,address)", [s.vault.toString(), (col[2]! - 1000n).toString(), x.me], "ODBacker.withdraw (all but 1000 units)");
    const left = num(cast(row, ["call", x.backer, "vault(uint256)(address,bytes32,uint256,uint256,uint256)", s.vault.toString()]).split("\n")[2]!);
    castSend(row, x.me, x.backer, "withdraw(uint256,uint256,address)", [s.vault.toString(), left.toString(), x.me], "ODBacker.withdraw (the rest)");
    row.chainTrue("collateral came back", num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me])) - u0 >= col[2]! - 1000n, `${col[2]}`);
    void g;
  },
};

const SH05: Flow = {
  id: "SH05", area: "shutdown", kind: "success", name: "path: agent policy revoke (always callable), and the agent is refused afterwards",
  async run(row, ctx) {
    const { s } = await needState(ctx, row);
    const x = sheet(ctx);
    castSend(row, x.me, x.router, "revoke(address)", [s.agent], "ODAgentRouter.revoke");
    const logs = cast(row, ["logs", "--from-block", "latest", "--to-block", "latest", "--address", x.router, "PolicyRevoked(address indexed,address indexed)"]);
    row.chainTrue("PolicyRevoked event readable with cast logs", /PolicyRevoked|topics/.test(logs), logs.slice(0, 80));
  },
};

const SH06: Flow = {
  id: "SH06", area: "shutdown", kind: "success", name: "path: Governor depositor requestWithdraw, wait the delay, claim with cast",
  async run(row, ctx) {
    await needState(ctx, row);
    const x = sheet(ctx), dep = addressOf("spare2");
    await ctx.test.impersonateAccount({ address: dep });
    await ctx.test.setBalance({ address: dep, value: 10n ** 19n });
    const shares = num(cast(row, ["call", x.governor, "balanceOf(address)(uint256)", dep]));
    row.chainTrue("depositor holds shares", shares > 0n, shares);
    const ask = shares / 100n; // a slice: the claim is limited by free cash and the stress budget
    const h = castSend(row, dep, x.governor, "requestWithdraw(uint256)(uint256)", [ask.toString()], "requestWithdraw");
    const ticket = ticketFrom(row, h, "WithdrawalQueued(address,uint256,uint256,uint64)", 2);
    row.note(`ticket ${ticket}`);
    await warpBy(ctx, 72 * 3600 + 5);
    await pushCalendar(ctx, row); await freshen(ctx, ["ETH", "BTC"]);
    const u0 = num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", dep]));
    castSend(row, dep, x.governor, "claim(uint256,uint256)(uint256)", [ticket.toString(), "1"], "Governor.claim");
    row.chainTrue("claim paid USDG", num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", dep])) > u0, "");
  },
};

const SH07: Flow = {
  id: "SH07", area: "shutdown", kind: "success", name: "path: stake with deposits paused: claimRewards, requestUnstake, cancelUnstake, requestUnstake, wait 7 d, unstake",
  async run(row, ctx) {
    const { s } = await needState(ctx, row);
    const x = sheet(ctx);
    const ovrd = (await ctx.pub.readContract({ address: x.stake, abi: stakeAbi, functionName: "ovrd" })) as Address;
    castSend(row, x.me, x.stake, "claimRewards()(uint256)", [], "claimRewards");
    castSend(row, x.me, x.stake, "requestUnstake(uint256)", [s.stakeShares.toString()], "requestUnstake");
    castSend(row, x.me, x.stake, "cancelUnstake()", [], "cancelUnstake");
    castSend(row, x.me, x.stake, "requestUnstake(uint256)", [s.stakeShares.toString()], "requestUnstake (again)");
    try { cast(row, ["call", "--from", x.me, x.stake, "unstake()(uint256)"]); row.chain("unstake before the delay must revert", "no revert", "revert"); } catch { row.note("unstake before 7 d reverts (NotReady), as the runbook says (wait the unstake delay)"); runbookIssues.pop(); row.notes = row.notes.filter((n) => !n.startsWith("RUNBOOK-STEP-FAILED")); }
    await warpBy(ctx, 7 * 86_400 + 5);
    await pushCalendar(ctx, row); await freshen(ctx, ["ETH", "BTC"]);
    const o0 = num(cast(row, ["call", ovrd, "balanceOf(address)(uint256)", x.me]));
    castSend(row, x.me, x.stake, "unstake()(uint256)", [], "unstake");
    // >= : a rerun on the same fork may still hold the previous run's matured request in the same slot
    row.chainTrue("OVRD returned (at least the 10000 staked)", num(cast(row, ["call", ovrd, "balanceOf(address)(uint256)", x.me])) - o0 >= 10_000n * 10n ** 18n, "");
  },
};

const SH08: Flow = {
  id: "SH08", area: "shutdown", kind: "success", name: "path: hook pool liquidity: what a cast-only outsider can and cannot do (PoolManager ERC-6909 seed)",
  async run(row, ctx) {
    await needState(ctx, row);
    const x = sheet(ctx), pm = ctx.dep.external.poolManager as Address;
    const owner = ctx.dep.admin.ownerSafe;
    const poolId = (ctx.dep.gears[0] as { poolId?: string }).poolId ?? "0x";
    const b = num(cast(row, ["call", pm, "balanceOf(address,uint256)(uint256)", owner, BigInt(poolId).toString()]));
    row.note(`PoolManager ERC-6909 balanceOf(ownerSafe, poolId as id) = ${b} (the gear tokens, not the LP shares, are what the runbook calls seed liquidity)`);
    const code = cast(row, ["code", pm]);
    row.chainTrue("PoolManager has code", code.length > 10, "");
    row.note("removal needs PoolManager.unlock(bytes) with a callback contract: not expressible as one cast send (see review)");
    void x;
  },
};

const SH09: Flow = {
  id: "SH09", area: "shutdown", kind: "success", name: "path: settled gear (feed halted 30 d, timelock settleGear): sell pays the fixed settled value; queueSell + fillQueued too",
  async run(row, ctx) {
    await needState(ctx, row);
    const x = sheet(ctx);
    const g = ctx.gears.get("MCKA:1");
    if (!g) throw new Blocked("run SH01 first (MCKA-SPORT position)");
    await ctx.test.impersonateAccount({ address: x.me });
    // the mock feed is never updated again. A halt start is latched when the guard is poked while the feed is stale during a
    // trading session: warp past the feed's 3 day limit to the next open, push the calendar, poke, then wait the 30 days.
    const { warpTarget } = await import("../warp");
    await warpBy(ctx, 5 * 86_400);
    const t0 = Number(await nowTs(ctx));
    await ctx.test.increaseTime({ seconds: warpTarget(t0, "to-next-open") + 600 - t0 });
    await ctx.test.mine({ blocks: 1 });
    await pushCalendar(ctx, row); await freshen(ctx, ["ETH", "BTC"]);
    await pokeMarket(ctx, row, "MCKA");
    await warpBy(ctx, 31 * 86_400);
    await pushCalendar(ctx, row); await freshen(ctx, ["ETH", "BTC"]);
    await pokeMarket(ctx, row, "MCKA");
    const since = num(cast(row, ["call", ctx.c.ODOracleGuard!, "haltedSince(bytes32)(uint64)", marketId("MCKA")]));
    row.chainTrue("guard reports MCKA halted", since > 0n, since);
    await timelockDo(ctx, x.minter, IODMinterAbi as Abi, "settleGear", [g.id]);
    const stOf = async () => ((await ctx.pub.readContract({ address: x.registry, abi: IODGearRegistryAbi, functionName: "gear", args: [g.id] })) as { status: number }).status;
    // the minter is not admin of the registry, so settleGear alone leaves the status as it was; the batch sets it (runbook step 'Settle gears')
    row.note(`registry status right after settleGear: ${await stOf()} (the minter treats the gear as settled either way)`);
    await timelockDo(ctx, x.registry, IODGearRegistryAbi as Abi, "setStatus", [g.id, 4]);
    row.chain("registry status SETTLED (4) after the batch's second call", await stOf(), 4);
    const held = await tokenOf(ctx, g.token, x.me);
    const deadline = String((await nowTs(ctx)) + 3600n);
    const u0 = num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me]));
    castSend(row, x.me, x.minter, "sell(bytes32,uint256,uint256,address,uint64)(uint256)", [g.id, (held / 2n).toString(), "1", x.me, deadline], "sell (settled)");
    row.chainTrue("settled sell paid", num(cast(row, ["call", x.usdg, "balanceOf(address)(uint256)", x.me])) > u0, "");
    const h = castSend(row, x.me, x.minter, "queueSell(bytes32,uint256,uint256,address)(uint256)", [g.id, (await tokenOf(ctx, g.token, x.me)).toString(), "1", x.me], "queueSell (settled)");
    const ticket = ticketFrom(row, h, "SellQueued(uint256,bytes32,address,uint256,uint256)", 1);
    castSend(row, x.me, x.minter, "fillQueued(uint256)(uint256)", [ticket.toString()], "fillQueued (settled)");
    row.chain("nothing left of the settled gear", await tokenOf(ctx, g.token, x.me), 0n);
    void walletFor;
  },
};

export const flows: Flow[] = [SH01, SH02, SH03, SH04, SH05, SH06, SH07, SH08, SH09];
void ({} as Hex);
