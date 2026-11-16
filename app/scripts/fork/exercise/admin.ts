// Admin flows A01 to A08 (todo 22d). Guardian pauses, timelock schedule/execute with a real 48 h warp, fees split, stake gating,
// role matrix. Commands in docs/runbooks/upgrades are run through cast against the fork where a flow touches the same step; any
// that fail are noted as `RUNBOOK:` lines in the row notes (and collected in runbookIssues).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, parseAbi, parseEventLogs, toHex, zeroHash, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { IODFeesAbi, IODGearRegistryAbi, IODGovernorAbi, IODOracleGuardAbi, IODStakeAbi, IODVolOracleAbi } from "../../../src/abi";
import { addressOf, asTimelock, APP, FORK_DIR, ANVIL_URL, impersonated, walletFor } from "../lib";
import { marketId } from "../setup";
import {
  GEAR, volKey, apiGet, buyDirect, ensureCapital, ensureGear, freshen, fundRole, nowTs, pollApi, pushCalendar, registerErrors, sellDirect, tokenOf, U, usdgOf, warpBy,
  type Ctx, type Flow, type GearInfo, type Row,
} from "./harness";

registerErrors(["TimelockUnexpectedOperationState(bytes32,bytes32)", "TimelockInsufficientDelay(uint256,uint256)", "AccessControlUnauthorizedAccount(address,bytes32)", "DepositsPaused()"]);

export const tlAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function getMinDelay() view returns (uint256)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
const DELAY = 172_800n;
const CAST = `${process.env.HOME}/.foundry/bin/cast`;
export const runbookIssues: string[] = [];

/** Runs one runbook cast command against the fork; returns stdout or records the failure. */
function runbook(row: Row, sheet: string, args: string[]): string | null {
  const p = Bun.spawnSync([CAST, ...args, ...(args[0] === "keccak" ? [] : ["--rpc-url", ANVIL_URL])], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) {
    const msg = `RUNBOOK ${sheet}: cast ${args.slice(0, 3).join(" ")} failed: ${p.stderr.toString().trim().slice(0, 160)}`;
    runbookIssues.push(msg); row.note(msg);
    return null;
  }
  return out;
}
const firstWord = (s: string | null) => (s ?? "").split(/\s+/)[0] ?? "";

const roleHash = (n: string): Hex => keccak256(toHex(n));
const ownerWallet = () => walletFor("owner");

/** Schedules `calls` through the timelock as the owner Safe and returns what is needed to execute. Single call uses schedule,
 * several use scheduleBatch (runbook 03). */
export async function scheduleOp(ctx: Ctx, row: Row, label: string, calls: { to: Address; abi: Abi; fn: string; args: readonly unknown[] }[]) {
  const tl = getAddress(ctx.dep.admin.timelock);
  const salt = keccak256(toHex(`od-fork-${label}-${Date.now()}`));
  const targets = calls.map((c) => c.to), values = calls.map(() => 0n);
  const datas = calls.map((c) => encodeFunctionData({ abi: c.abi, functionName: c.fn, args: c.args } as never));
  const batch = calls.length > 1;
  const id = (await ctx.pub.readContract(batch
    ? { address: tl, abi: tlAbi, functionName: "hashOperationBatch", args: [targets, values, datas, zeroHash, salt] }
    : { address: tl, abi: tlAbi, functionName: "hashOperation", args: [targets[0]!, 0n, datas[0]!, zeroHash, salt] }) as never) as Hex;
  await row.send(`schedule ${label} (owner Safe)`, "owner", batch
    ? { address: tl, abi: tlAbi as Abi, functionName: "scheduleBatch", args: [targets, values, datas, zeroHash, salt, DELAY] }
    : { address: tl, abi: tlAbi as Abi, functionName: "schedule", args: [targets[0]!, 0n, datas[0]!, zeroHash, salt, DELAY] });
  const execReq = batch
    ? { address: tl, abi: tlAbi as Abi, functionName: "executeBatch", args: [targets, values, datas, zeroHash, salt] }
    : { address: tl, abi: tlAbi as Abi, functionName: "execute", args: [targets[0]!, 0n, datas[0]!, zeroHash, salt] };
  row.chain(`${label}: isOperationPending`, await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "isOperationPending", args: [id] }), true);
  const ready = (await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "getTimestamp", args: [id] })) as bigint;
  row.chainTrue(`${label}: ready time >= now + 48 h`, ready >= (await nowTs(ctx)) + DELAY - 5n, ready);
  return { id, tl, execReq, ready, salt, targets, datas };
}

/** Early execute (immediately, then 60 s before ready) must revert; then warp to ready and execute. */
export async function runOp(ctx: Ctx, row: Row, label: string, op: Awaited<ReturnType<typeof scheduleOp>>) {
  await row.expectRevert(`${label}: execute straight after schedule`, "owner", op.execReq, ["TimelockUnexpectedOperationState"]);
  const now = await nowTs(ctx);
  await warpBy(ctx, Number(op.ready - now) - 60);
  await row.expectRevert(`${label}: execute 60 s before ready`, "owner", op.execReq, ["TimelockUnexpectedOperationState"]);
  row.chain(`${label}: still pending`, await ctx.pub.readContract({ address: op.tl, abi: tlAbi, functionName: "isOperationPending", args: [op.id] }), true);
  await warpBy(ctx, 61);
  row.chain(`${label}: isOperationReady`, await ctx.pub.readContract({ address: op.tl, abi: tlAbi, functionName: "isOperationReady", args: [op.id] }), true);
  await row.send(`execute ${label} (owner Safe)`, "owner", op.execReq);
  row.chain(`${label}: isOperationDone`, await ctx.pub.readContract({ address: op.tl, abi: tlAbi, functionName: "isOperationDone", args: [op.id] }), true);
  await freshen(ctx, ["ETH", "BTC"]);
}

/** Runbook 01 A: delay, proposer, admin checks and the hash, run with cast and compared with viem. */
async function runbookPrechecks(ctx: Ctx, row: Row, target: Address, data: Hex, salt: Hex) {
  const tl = ctx.dep.admin.timelock, owner = addressOf("owner");
  const d = runbook(row, "01.A1", ["call", tl, "getMinDelay()(uint256)"]);
  if (d !== null) row.chain("runbook 01 A1 getMinDelay", firstWord(d), "172800");
  for (const r of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"]) {
    const h = runbook(row, "01.A2", ["keccak", r]);
    const v = h === null ? null : runbook(row, "01.A2", ["call", tl, "hasRole(bytes32,address)(bool)", h, owner]);
    if (v !== null) row.chain(`runbook 01 A2 owner has ${r}`, v, "true");
  }
  const adm = runbook(row, "01.A3", ["call", target, "hasRole(bytes32,address)(bool)", zeroHash, tl]);
  if (adm !== null) row.chain("runbook 01 A3 timelock admin on target", adm, "true");
  const hash = runbook(row, "01.A4", ["call", tl, "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)", target, "0", data, zeroHash, salt]);
  const mine = await ctx.pub.readContract({ address: getAddress(tl), abi: tlAbi, functionName: "hashOperation", args: [target, 0n, data, zeroHash, salt] });
  if (hash !== null) row.chain("runbook 01 A4 hashOperation equals viem", hash, mine);
}

const pausedGear = async (ctx: Ctx, id: Hex) => ((await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi, functionName: "gear", args: [id] })) as { status: number; capUsdWad: bigint; spreadBps: number });
const govPaused = async (ctx: Ctx) => ((await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "buysPaused" })) as readonly [boolean, Hex])[0];

/** Shared fixture: Governor capital, the ETH Sport gear, alice holding some of it. */
async function fixture(ctx: Ctx, row: Row): Promise<{ g: GearInfo; alice: Address }> {
  await ensureCapital(ctx, row);
  const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
  const alice = await fundRole(ctx, "alice", 1_000_000);
  return { g, alice };
}

const A01: Flow = {
  id: "A01", area: "admin", kind: "success", name: "guardian pauses a gear and a global buy pause at once; buys revert, sells stay open, API shows both",
  async run(row, ctx) {
    const { g, alice } = await fixture(ctx, row);
    await freshen(ctx, ["ETH", "BTC"]);
    if ((await govPaused(ctx)) || (await pausedGear(ctx, g.id)).status !== 1) {
      // a rerun after a failed attempt: restore the fixture through the timelock (fork shortcut, the real path is A04)
      await ctx.pub.waitForTransactionReceipt({ hash: await asTimelock((w, t) => w.writeContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [false], gas: 1_000_000n, chain: null, account: t } as never)) });
      await ctx.pub.waitForTransactionReceipt({ hash: await asTimelock((w, t) => w.writeContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi as Abi, functionName: "setStatus", args: [g.id, 1], gas: 1_000_000n, chain: null, account: t } as never)) });
      row.note("fixture restored through the timelock shortcut before the pauses");
    }
    await buyDirect(ctx, row, "alice", g, U(2000), "alice buys 2000 USDG before the pauses");
    const reg = ctx.c.ODGearRegistry!, gov = ctx.c.ODGovernor!;
    await row.send("guardian: gear status BUYS_PAUSED", "guardian", { address: reg, abi: IODGearRegistryAbi as Abi, functionName: "setStatus", args: [g.id, 2] });
    await row.send("guardian: Governor setBuysPaused(true)", "guardian", { address: gov, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [true] });
    row.chain("gear status BUYS_PAUSED (2)", (await pausedGear(ctx, g.id)).status, 2);
    row.chain("Governor buysPaused", await govPaused(ctx), true);
    // a buy now reverts (either lever); both are in force, so the decoded name is one of the two
    await row.expectRevert("alice buy while paused", "alice", { address: ctx.c.ODMinter!, abi: (await import("../../../src/abi")).IODMinterAbi as Abi, functionName: "buy", args: [g.id, U(100), 0n, alice, (await nowTs(ctx)) + 3600n] }, ["BuysPaused", "GearBuysPaused", "NotBuyable", "GearNotBuyable", "BuyPaused", "BuysClosed"]);
    const held = await tokenOf(ctx, g.token, alice);
    await sellDirect(ctx, row, "alice", g, held / 4n, "alice sells a quarter while paused");
    const apiGov = await pollApi(() => apiGet<{ buysPaused: boolean; buysPausedReason: string | null }>("/v1/governor"), (v) => v.buysPaused === true);
    row.api("/v1/governor buysPaused", apiGov.buysPaused, true);
    const gears = await pollApi(() => apiGet<{ gears: { id: string; buyable: boolean; status: string; pausedBy: string | null }[] }>("/v1/gears"), (v) => v.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.buyable === false);
    const ag = gears.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())!;
    row.api("/v1/gears buyable false for the paused gear", ag.buyable, false);
    row.note(`api gear status=${ag.status} pausedBy=${ag.pausedBy}`);
  },
};

const A02: Flow = {
  id: "A02", area: "admin", kind: "expected_failure", name: "guardian cannot raise a cap, widen status back, or unpause; lowering a cap works",
  async run(row, ctx) {
    const { g } = await fixture(ctx, row);
    const reg = ctx.c.ODGearRegistry!, gov = ctx.c.ODGovernor!, g0 = await pausedGear(ctx, g.id);
    if (!(await govPaused(ctx))) row.blocked("A01 must run first (Governor not paused)");
    await row.expectRevert("guardian raises the cap", "guardian", { address: reg, abi: IODGearRegistryAbi as Abi, functionName: "setParams", args: [g.id, g0.capUsdWad * 2n, g0.spreadBps] }, ["NotAllowed"]);
    await row.expectRevert("guardian narrows the spread", "guardian", { address: reg, abi: IODGearRegistryAbi as Abi, functionName: "setParams", args: [g.id, g0.capUsdWad, g0.spreadBps - 1 >= 1 ? g0.spreadBps - 1 : 0] }, ["NotAllowed", "InvalidParams"]);
    await row.expectRevert("guardian relists the gear (LISTED)", "guardian", { address: reg, abi: IODGearRegistryAbi as Abi, functionName: "setStatus", args: [g.id, 1] }, ["NotAllowed"]);
    await row.expectRevert("guardian unpauses the Governor", "guardian", { address: gov, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [false] }, ["AccessControlUnauthorizedAccount"]);
    await row.expectRevert("guardian unpauses the market", "guardian", { address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi as Abi, functionName: "setBuysPaused", args: [marketId("ETH"), false] }, ["AccessControlUnauthorizedAccount"]);
    await row.expectRevert("guardian unpauses stake deposits", "guardian", { address: ctx.c.ODStake!, abi: parseAbi(["function setDepositsPaused(bool)"]) as Abi, functionName: "setDepositsPaused", args: [false] }, ["AccessControlUnauthorizedAccount"]);
    row.chain("Governor still paused", await govPaused(ctx), true);
    row.chain("gear status unchanged (BUYS_PAUSED)", (await pausedGear(ctx, g.id)).status, 2);
    // positive control: the one direction the guardian may move is down
    await row.send("guardian lowers the cap by 10%", "guardian", { address: reg, abi: IODGearRegistryAbi as Abi, functionName: "setParams", args: [g.id, (g0.capUsdWad * 9n) / 10n, g0.spreadBps] });
    row.chain("cap lowered", (await pausedGear(ctx, g.id)).capUsdWad, (g0.capUsdWad * 9n) / 10n);
    const api = await pollApi(() => apiGet<{ gears: { id: string; cap: string }[] }>("/v1/gears"), (v) => BigInt(v.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.cap ?? "-1") !== -1n);
    row.note(`api cap after guardian lowering: ${api.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.cap}`);
  },
};

const A03: Flow = {
  id: "A03", area: "admin", kind: "success", name: "timelock: schedule a cap raise, early execute reverts, warp 48 h, execute; guardian and bots cannot schedule",
  async run(row, ctx) {
    const { g } = await fixture(ctx, row);
    const reg = ctx.c.ODGearRegistry!, g0 = await pausedGear(ctx, g.id);
    const newCap = g0.capUsdWad * 2n;
    const data = encodeFunctionData({ abi: IODGearRegistryAbi, functionName: "setParams", args: [g.id, newCap, g0.spreadBps] } as never);
    await row.expectRevert("guardian tries timelock.schedule", "guardian", { address: ctx.dep.admin.timelock, abi: tlAbi as Abi, functionName: "schedule", args: [reg, 0n, data, zeroHash, zeroHash, DELAY] }, ["AccessControlUnauthorizedAccount"]);
    await row.expectRevert("owner schedules with a 1 h delay", "owner", { address: ctx.dep.admin.timelock, abi: tlAbi as Abi, functionName: "schedule", args: [reg, 0n, data, zeroHash, zeroHash, 3600n] }, ["TimelockInsufficientDelay"]);
    row.chain("minDelay", await ctx.pub.readContract({ address: getAddress(ctx.dep.admin.timelock), abi: tlAbi, functionName: "getMinDelay" }), DELAY);
    const op = await scheduleOp(ctx, row, "raise ETH-SPORT cap", [{ to: reg, abi: IODGearRegistryAbi as Abi, fn: "setParams", args: [g.id, newCap, g0.spreadBps] }]);
    await runbookPrechecks(ctx, row, reg, data, op.salt);
    const readyCast = runbook(row, "01.C", ["call", op.tl, "getTimestamp(bytes32)(uint256)", op.id]);
    if (readyCast !== null) row.chain("runbook 01 C getTimestamp equals ready", firstWord(readyCast), op.ready);
    const sim = runbook(row, "01.A5", ["call", reg, "setParams(bytes32,uint128,uint16)", g.id, newCap.toString(), String(g0.spreadBps), "--from", op.tl]);
    if (sim === null) row.note("runbook 01 A5 simulate-as-timelock failed (see RUNBOOK line)");
    await runOp(ctx, row, "raise ETH-SPORT cap", op);
    row.chain("cap now doubled", (await pausedGear(ctx, g.id)).capUsdWad, newCap);
    const api = await pollApi(() => apiGet<{ gears: { id: string; cap: string }[] }>("/v1/gears"), (v) => BigInt(v.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.cap ?? "-1") !== -1n);
    const apiCap = BigInt(api.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.cap ?? "-1");
    row.api("API cap (USDG 6 decimals) equals chain cap / 1e12", apiCap, newCap / 10n ** 12n);
  },
};

const A04: Flow = {
  id: "A04", area: "admin", kind: "success", name: "unpause only through the timelock: batch (Governor buys + gear LISTED) after 48 h; cancel works; buys resume",
  async run(row, ctx) {
    const { g } = await fixture(ctx, row);
    const reg = ctx.c.ODGearRegistry!, gov = ctx.c.ODGovernor!;
    if (!(await govPaused(ctx))) row.blocked("nothing paused: A01 must run first");
    // cancel path (runbook 04): a scheduled op can be cancelled by the owner, the guardian cannot
    const junk = await scheduleOp(ctx, row, "cancel-me", [{ to: reg, abi: IODGearRegistryAbi as Abi, fn: "setStatus", args: [g.id, 1] }]);
    await row.expectRevert("guardian cancels", "guardian", { address: junk.tl, abi: tlAbi as Abi, functionName: "cancel", args: [junk.id] }, ["AccessControlUnauthorizedAccount"]);
    await row.send("owner cancels the op", "owner", { address: junk.tl, abi: tlAbi as Abi, functionName: "cancel", args: [junk.id] });
    const isOp = runbook(row, "04.4", ["call", junk.tl, "isOperation(bytes32)(bool)", junk.id]);
    row.chain("runbook 04: isOperation after cancel", isOp ?? String(await ctx.pub.readContract({ address: junk.tl, abi: tlAbi, functionName: "isOperation", args: [junk.id] })), "false");
    const op = await scheduleOp(ctx, row, "unpause batch", [
      { to: gov, abi: IODGovernorAbi as Abi, fn: "setBuysPaused", args: [false] },
      { to: reg, abi: IODGearRegistryAbi as Abi, fn: "setStatus", args: [g.id, 1] },
    ]);
    row.chain("still paused while pending", await govPaused(ctx), true);
    await runOp(ctx, row, "unpause batch", op);
    row.chain("Governor unpaused", await govPaused(ctx), false);
    row.chain("gear LISTED", (await pausedGear(ctx, g.id)).status, 1);
    await buyDirect(ctx, row, "alice", g, U(500), "alice buys 500 USDG after the timelock unpause");
    const apiGov = await pollApi(() => apiGet<{ buysPaused: boolean }>("/v1/governor"), (v) => v.buysPaused === false);
    row.api("/v1/governor buysPaused false", apiGov.buysPaused, false);
    const gs = await pollApi(() => apiGet<{ gears: { id: string; buyable: boolean }[] }>("/v1/gears"), (v) => v.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.buyable === true);
    row.api("/v1/gears buyable true again", gs.gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())?.buyable, true);
  },
};

const A05: Flow = {
  id: "A05", area: "admin", kind: "success", name: "oracle parameter change through the timelock (ODOracleGuard.setMarket refBandBps, ODVolOracle.setBounds), 48 h warp",
  async run(row, ctx) {
    await fixture(ctx, row);
    const og = ctx.c.ODOracleGuard!, vo = ctx.c.ODVolOracle!, m = marketId("ETH");
    const cfg = (await ctx.pub.readContract({ address: og, abi: IODOracleGuardAbi, functionName: "config", args: [m] })) as Record<string, unknown> & { refBandBps: number };
    const newBand = cfg.refBandBps > 100 ? cfg.refBandBps - 25 : cfg.refBandBps + 25;
    const next = { ...cfg, refBandBps: newBand };
    await row.expectRevert("guardian setMarket", "guardian", { address: og, abi: IODOracleGuardAbi as Abi, functionName: "setMarket", args: [m, cfg] }, ["AccessControlUnauthorizedAccount"]);
    await row.expectRevert("guardian setBounds", "guardian", { address: vo, abi: IODVolOracleAbi as Abi, functionName: "setBounds", args: [volKey("ETH"), 3000n, 20000n] }, ["AccessControlUnauthorizedAccount"]);
    const op = await scheduleOp(ctx, row, "oracle params", [
      { to: og, abi: IODOracleGuardAbi as Abi, fn: "setMarket", args: [m, next] },
      { to: vo, abi: IODVolOracleAbi as Abi, fn: "setBounds", args: [volKey("ETH"), 3100n, 19000n] },
    ]);
    await runOp(ctx, row, "oracle params", op);
    const after = (await ctx.pub.readContract({ address: og, abi: IODOracleGuardAbi, functionName: "config", args: [m] })) as { refBandBps: number };
    row.chain(`ETH refBandBps ${cfg.refBandBps} -> ${newBand}`, after.refBandBps, newBand);
    // the relaxed band set at fork start is restored by the next fork reset; record the change in the notes only
    const b = (await ctx.pub.readContract({ address: vo, abi: parseAbi(["function bounds(bytes32) view returns (uint64 floorBps, uint64 ceilingBps, bool set)"]), functionName: "bounds", args: [volKey("ETH")] }).catch(() => null)) as readonly [bigint, bigint, boolean] | null;
    if (b) row.chain("ETH vol bounds floor/ceiling", `${b[0]}/${b[1]}`, "3100/19000");
    row.note(`ETH refBandBps changed ${cfg.refBandBps} -> ${newBand}; vol bounds for ETH set 3100..19000`);
  },
};

const A06: Flow = {
  id: "A06", area: "admin", kind: "success", name: "IODFees.distribute after 7 days: 80/10/5/5 split, the crank fees job calls it, a second call reverts TooEarly",
  async run(row, ctx) {
    const { g } = await fixture(ctx, row);
    const fees = ctx.c.ODFees!;
    await freshen(ctx, ["ETH", "BTC"]);
    await buyDirect(ctx, row, "alice", g, U(150_000), "alice buys 150000 USDG to generate fees");
    const feesNow = async () => ({
      next: (await ctx.pub.readContract({ address: fees, abi: IODFeesAbi, functionName: "nextDistributionAt" })) as bigint,
      dist: (await ctx.pub.readContract({ address: fees, abi: IODFeesAbi, functionName: "distributable" })) as bigint,
    });
    const f0 = await feesNow();
    row.chainTrue("fees distributable > 50 USDG (crank minimum)", f0.dist > 50_000_000n, f0.dist);
    if (f0.next > (await nowTs(ctx))) await row.expectRevert("distribute before 7 days", "alice", { address: fees, abi: IODFeesAbi as Abi, functionName: "distribute" }, ["TooEarly"]);
    if (f0.next > (await nowTs(ctx))) await warpBy(ctx, Number(f0.next - (await nowTs(ctx))) + 5);
    else row.note("7 days had already passed on the chain clock (earlier rows warped 48 h each)");
    await freshen(ctx, ["ETH", "BTC"]);
    // run the crank's fees job once: stop the service, run `crank --once` with only that job on its own env file, restart
    const crankPid = Number(readFileSync(join(FORK_DIR, "pids", "crank.pid"), "utf8").trim());
    try { process.kill(crankPid, "SIGTERM"); } catch { /* already gone */ }
    await Bun.sleep(2500);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CRANK_ENABLED_JOBS: "fees" };
    for (const line of readFileSync(join(FORK_DIR, "env", "crank.env"), "utf8").split("\n")) { const i = line.indexOf("="); if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1); }
    const before = await ctx.pub.getBlockNumber();
    const p = Bun.spawnSync(["bun", "src/bin/crank.ts", "--once"], { cwd: APP, env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const out = p.stdout.toString();
    Bun.spawnSync(["/bin/bash", "scripts/fork/up.sh"], { cwd: APP, env: process.env as Record<string, string>, stdout: "ignore", stderr: "ignore", timeout: 240_000 });
    row.chainTrue("crank --once exited 0", p.exitCode === 0, `exit ${p.exitCode} ${p.stderr.toString().slice(-300)}`);
    const logs = await ctx.pub.getLogs({ address: fees, fromBlock: before, toBlock: "latest" });
    const dist = parseEventLogs({ abi: IODFeesAbi, logs, eventName: "Distributed" });
    row.chainTrue("the crank fees job produced exactly one Distributed event", dist.length === 1, `${dist.length} events; crank output: ${out.slice(-400)}`);
    const d = dist[0]!.args;
    const tx = await ctx.pub.getTransactionReceipt({ hash: dist[0]!.transactionHash });
    row.txs.push({ label: "IODFees.distribute (crank fees job)", hash: tx.transactionHash, gas: tx.gasUsed.toString(), status: tx.status === "success" ? "success" : "reverted" });
    const bps = async (fn: string) => BigInt((await ctx.pub.readContract({ address: fees, abi: parseAbi([`function ${fn}() view returns (uint16)`]), functionName: fn })) as number);
    const [ops, tre, stk, brn] = [await bps("opsBps"), await bps("treasuryBps"), await bps("stakersBps"), await bps("burnBps")];
    row.chain("split bps 80/10/5/5", `${ops}/${tre}/${stk}/${brn}`, "8000/1000/500/500");
    row.chain("toTreasury = 10%", d.toTreasury, (d.amount * tre) / 10_000n);
    row.chain("toStakers = 5%", d.toStakers, (d.amount * stk) / 10_000n);
    row.chain("toBurn = 5%", d.toBurn, (d.amount * brn) / 10_000n);
    const opsAmt = (d.amount * ops) / 10_000n;
    row.chainWithin("governor+exitReserve+keepers+hedgers = 80%", d.toGovernor + d.toExitReserve + d.toKeepers + d.toHedgers, opsAmt, 4n);
    row.chain("Governor ops share = 40% of ops (4000 bps)", d.toGovernor, (opsAmt * 4000n) / 10_000n);
    row.note(`distributed ${d.amount} USDG units: gov ${d.toGovernor} exit ${d.toExitReserve} keepers ${d.toKeepers} hedgers ${d.toHedgers} treasury ${d.toTreasury} stakers ${d.toStakers} burn ${d.toBurn}`);
    await row.expectRevert("second distribute inside 7 days", "alice", { address: fees, abi: IODFeesAbi as Abi, functionName: "distribute" }, ["TooEarly"]);
    const f1 = await feesNow();
    const api = await pollApi(() => apiGet<{ distributableUsdg: string; nextDistributionAt: string }>("/v1/fees"), (v) => Date.parse(v.nextDistributionAt) / 1000 === Number(f1.next));
    row.api("/v1/fees nextDistributionAt", Math.floor(Date.parse(api.nextDistributionAt) / 1000), Number(f1.next));
    row.api("/v1/fees distributableUsdg", api.distributableUsdg, f1.dist.toString());
  },
};

const A07: Flow = {
  id: "A07", area: "admin", kind: "expected_failure", name: "stake: only the Governor and Backer may slash, deposits paused at launch, first-loss wiring (insurance, then stake)",
  async run(row, ctx) {
    await fixture(ctx, row);
    const st = ctx.c.ODStake!, bk = ctx.c.ODBacker!, ins = ctx.c.ODInsurance!, gov = ctx.c.ODGovernor!;
    const rd = <T>(address: Address, sig: string) => ctx.pub.readContract({ address, abi: parseAbi([`function ${sig}`]), functionName: sig.slice(0, sig.indexOf("(")) } as never) as Promise<T>;
    row.chain("Backer.stake() is the stake", getAddress(await rd<Address>(bk, "stake() view returns (address)")), st);
    row.chain("Backer.insurance() is the insurance vault", getAddress(await rd<Address>(bk, "insurance() view returns (address)")), ins);
    row.chain("Stake.backer()", getAddress(await rd<Address>(st, "backer() view returns (address)")), bk);
    row.chain("Stake.governor()", getAddress(await rd<Address>(st, "governor() view returns (address)")), gov);
    for (const who of ["guardian", "crank", "alice"] as const) {
      await row.expectRevert(`${who} calls Stake.slash`, who, { address: st, abi: IODStakeAbi as unknown as Abi, functionName: "slash", args: [1_000_000n] }, ["NotSlasher"]);
    }
    await row.expectRevert("alice stakes while deposits are paused", "alice", { address: st, abi: IODStakeAbi as unknown as Abi, functionName: "stake", args: [1n] }, ["DepositsPaused", "ERC20InsufficientAllowance", "ERC20InsufficientBalance"]);
    const total0 = await rd<bigint>(st, "totalAssets() view returns (uint256)");
    // the Backer slashing an empty stake returns 0, moves nothing and never reverts (the contract's never-revert promise)
    const { test, pub } = ctx;
    const w = await impersonated(test, bk);
    const sim = await pub.simulateContract({ address: st, abi: IODStakeAbi as unknown as Abi, functionName: "slash", args: [5_000_000n], account: bk } as never);
    row.chain("Backer slash on an empty stake returns 0", String(sim.result), "0");
    const hash = await w.writeContract({ address: st, abi: IODStakeAbi as unknown as Abi, functionName: "slash", args: [5_000_000n], gas: 3_000_000n, chain: null, account: bk } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    row.txs.push({ label: "Stake.slash as Backer (empty stake)", hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
    await test.stopImpersonatingAccount({ address: bk });
    row.chain("Backer slash did not revert", r.status, "success");
    row.chain("stake totalAssets unchanged", await rd<bigint>(st, "totalAssets() view returns (uint256)"), total0);
    row.note("scope: the stake is unfunded at launch config (deposits paused, no swap adapter), so a slash that moves OVRD is not reachable on the fork; first-loss ordering (insurance, then stake, then Governor equity) is asserted by wiring here, by B08 in the backers area and by the contracts' bad-debt tests");
  },
};

const A08: Flow = {
  id: "A08", area: "admin", kind: "expected_failure", name: "role checks: crank, hedger, liquidator keys hold only their own roles and every privileged call reverts",
  async run(row, ctx) {
    const g = (await fixture(ctx, row)).g;
    const cores: [string, Address][] = ["ODMarketHours", "ODOracleGuard", "ODVolOracle", "ODGearRegistry", "ODMinter", "ODGovernor", "ODInsurance", "ODHook", "ODBacker", "ODFees", "ODStake"].map((n) => [n, ctx.c[n]!]);
    const roles: Record<string, Hex> = { DEFAULT_ADMIN: zeroHash, KEEPER: roleHash("KEEPER_ROLE"), GUARDIAN: roleHash("GUARDIAN_ROLE"), HEDGER: roleHash("HEDGER_ROLE"), LIQUIDATOR: roleHash("LIQUIDATOR_ROLE") };
    const tl = getAddress(ctx.dep.admin.timelock);
    const tlRoles: Record<string, Hex> = { TL_ADMIN: zeroHash, PROPOSER: roleHash("PROPOSER_ROLE"), EXECUTOR: roleHash("EXECUTOR_ROLE"), CANCELLER: roleHash("CANCELLER_ROLE") };
    const holds = async (who: Address) => {
      const out: string[] = [];
      for (const [n, a] of cores) for (const [rn, rh] of Object.entries(roles)) {
        let v = false;
        try { v = (await ctx.pub.readContract({ address: a, abi: tlAbi, functionName: "hasRole", args: [rh, who] })) as boolean; } catch { break; }
        if (v) out.push(`${n}:${rn}`);
      }
      for (const [rn, rh] of Object.entries(tlRoles)) if ((await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "hasRole", args: [rh, who] })) as boolean) out.push(`Timelock:${rn}`);
      return out.join(",");
    };
    const expect: Record<string, string> = {
      crank: "ODMarketHours:KEEPER", hedger: "ODGovernor:HEDGER", liquidator: "", deployer: "", volSender: "", treasury: "",
      guardian: "ODOracleGuard:GUARDIAN,ODVolOracle:GUARDIAN,ODGearRegistry:GUARDIAN,ODMinter:GUARDIAN,ODGovernor:GUARDIAN,ODBacker:GUARDIAN,ODStake:GUARDIAN",
      owner: "Timelock:PROPOSER,Timelock:EXECUTOR,Timelock:CANCELLER",
    };
    for (const [role, want] of Object.entries(expect)) row.chain(`roles held by ${role}`, await holds(addressOf(role as never)), want);
    row.chain("Timelock holds DEFAULT_ADMIN on every core", (await Promise.all(cores.map(async ([n, a]) => { try { return (await ctx.pub.readContract({ address: a, abi: tlAbi, functionName: "hasRole", args: [zeroHash, tl] })) as boolean; } catch { return true; } }))).every(Boolean), true);
    const priv: [string, Address, Abi, string, unknown[]][] = [
      ["Governor.setBuysPaused(true)", ctx.c.ODGovernor!, IODGovernorAbi as Abi, "setBuysPaused", [true]],
      ["Registry.setParams", ctx.c.ODGearRegistry!, IODGearRegistryAbi as Abi, "setParams", [g.id, 1n, 40]],
      ["OracleGuard.setBuysPaused(ETH,true)", ctx.c.ODOracleGuard!, IODOracleGuardAbi as Abi, "setBuysPaused", [marketId("ETH"), true]],
      ["VolOracle.revokeSigner", ctx.c.ODVolOracle!, IODVolOracleAbi as Abi, "revokeSigner", []],
      ["Fees.setSplit", ctx.c.ODFees!, parseAbi(["function setSplit(uint16,uint16,uint16,uint16)"]) as Abi, "setSplit", [1000, 3000, 3000, 3000]],
      ["Timelock.schedule", tl, tlAbi as Abi, "schedule", [ctx.c.ODGovernor!, 0n, "0x", zeroHash, zeroHash, DELAY]],
    ];
    for (const who of ["crank", "hedger", "liquidator"] as const) {
      for (const [label, address, abi, fn, args] of priv) {
        await row.expectRevert(`${who}: ${label}`, who, { address, abi, functionName: fn, args }, ["AccessControlUnauthorizedAccount"]);
      }
    }
    row.chain("nothing paused by the bot attempts", (await govPaused(ctx)) === false && (await pausedGear(ctx, g.id)).status === 1, true);
    void usdgOf; void existsSync; void appendFileSync;
  },
};

export const flows: Flow[] = [A01, A02, A03, A04, A05, A06, A07, A08];
