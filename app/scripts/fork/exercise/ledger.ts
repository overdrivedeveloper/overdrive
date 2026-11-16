// Tracker 69a: a real guardian pause and its scheduled unpause on the fork, written up in the pause ledger format
// (docs/runbooks/upgrades/PAUSE-LEDGER.md), with holder exits open the whole time. Rerun:
//   bun scripts/fork/exercise/index.ts --area ledger --only L01
// The ledger copy is written to $FORK_DIR/PAUSE-LEDGER.fork.md (the real ledger in docs/ is never touched by a fork run).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Abi } from "viem";
import { IODGearRegistryAbi, IODGovernorAbi } from "../../../src/abi";
import { FORK_DIR } from "../lib";
import { pushCalendar } from "./harness";
import { GEAR, buyDirect, ensureCapital, ensureGear, freshen, fundRole, nowTs, sellDirect, tokenOf, U, warpBy, type Flow } from "./harness";
import { scheduleOp, tlAbi } from "./admin";
import { LEDGER_HEADER, formatRow, parseLedger, unpausedWithoutPlan, utcStamp, type LedgerRow } from "./pause-ledger";
import { asTimelock } from "../lib";

const govPaused = async (ctx: Parameters<Flow["run"]>[1]) =>
  ((await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "buysPaused" })) as readonly [boolean, `0x${string}`])[0];

export const L01: Flow = {
  id: "L01", area: "ledger", kind: "success",
  name: "pause ledger (69a): guardian pauses Governor buys, ledger rows written, unpause scheduled the same hour, 48 h warp, timelock executes, exits open throughout",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    const alice = await fundRole(ctx, "alice", 1_000_000);
    await freshen(ctx, ["ETH", "BTC"]);
    const gov = ctx.c.ODGovernor!, reg = ctx.c.ODGearRegistry!, tl = getAddress(ctx.dep.admin.timelock);
    if (await govPaused(ctx)) {
      // a rerun after a failed attempt: restore through the timelock (fork shortcut)
      await ctx.pub.waitForTransactionReceipt({ hash: await asTimelock((w, t) => w.writeContract({ address: gov, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [false], gas: 1_000_000n, chain: null, account: t } as never)) });
      row.note("fixture restored through the timelock shortcut before the pause");
    }
    await buyDirect(ctx, row, "alice", g, U(3000), "alice buys 3000 USDG before the pause");

    // 1. the guardian pauses (one transaction)
    const pause = await row.send("guardian: Governor setBuysPaused(true)", "guardian", { address: gov, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [true] });
    const tPause = await nowTs(ctx);
    row.chain("Governor buysPaused", await govPaused(ctx), true);
    // 2. the unpause is scheduled through the timelock in the same hour (ledger rule 1, README rule 3)
    const op = await scheduleOp(ctx, row, "ledger unpause", [{ to: gov, abi: IODGovernorAbi as Abi, fn: "setBuysPaused", args: [false] }]);
    const sched = row.txs[row.txs.length - 1]!; // scheduleOp's last send is the schedule tx
    const tSched = await nowTs(ctx);
    row.chainTrue("pause and schedule in the same hour", tSched - tPause < 3600n, `${tSched - tPause} s apart`);
    const ready = (await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "getTimestamp", args: [op.id] })) as bigint;
    row.chain("getTimestamp (read order step 1) equals the scheduler's ready time", ready, op.ready);

    // 3. the ledger: two rows, as PAUSE-LEDGER.md asks
    const ledger: LedgerRow[] = [
      { when: utcStamp(tPause), lever: "ODGovernor buys", action: "guardian pause (setBuysPaused true)", tx: pause.hash, unpauseOp: op.id, ready: `${utcStamp(ready)} UTC / fork`, why: "fork test of the pause ledger (69a)", closed: "" },
      { when: utcStamp(tSched), lever: "ODGovernor buys", action: "unpause scheduled (timelock, 48 h)", tx: sched.hash, unpauseOp: op.id, ready: `${utcStamp(ready)} UTC / fork`, why: "same hour as the pause", closed: "" },
    ];
    const file = join(FORK_DIR, "PAUSE-LEDGER.fork.md");
    const write = () => { mkdirSync(FORK_DIR, { recursive: true }); writeFileSync(file, `# Pause ledger (fork copy)\n\n${LEDGER_HEADER}\n${ledger.map(formatRow).join("\n")}\n`); };
    write();
    row.chain("ledger rows written", parseLedger(await Bun.file(file).text()).length, 2);
    row.chain("ledger rule 1: no pause without a plan", unpausedWithoutPlan(ledger).length, 0);

    // 4. while paused: buys revert, exits stay open (holder sell now, and again 47 h later)
    await row.expectRevert("alice buy while paused", "alice", { address: ctx.c.ODMinter!, abi: (await import("../../../src/abi")).IODMinterAbi as Abi, functionName: "buy", args: [g.id, U(100), 0n, alice, (await nowTs(ctx)) + 3600n] }, ["BuysPaused", "GearBuysPaused", "NotBuyable", "GearNotBuyable", "BuyPaused", "BuysClosed"]);
    const held0 = await tokenOf(ctx, g.token, alice);
    await sellDirect(ctx, row, "alice", g, held0 / 4n, "alice sells a quarter right after the pause");
    await row.expectRevert("owner executes straight after schedule", "owner", op.execReq, ["TimelockUnexpectedOperationState"]);

    // 5. time passes: 47 h in, still paused, early execute reverts, a sell still works
    await warpBy(ctx, Number(ready - (await nowTs(ctx))) - 3600 * 1);
    await pushCalendar(ctx, row); await freshen(ctx, ["ETH", "BTC"]);
    row.chain("still paused one hour before ready", await govPaused(ctx), true);
    row.chain("op pending one hour before ready", await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "isOperationPending", args: [op.id] }), true);
    await row.expectRevert("owner executes one hour early", "owner", op.execReq, ["TimelockUnexpectedOperationState"]);
    const held1 = await tokenOf(ctx, g.token, alice);
    await sellDirect(ctx, row, "alice", g, held1 / 4n, "alice sells again one hour before the unpause is ready");
    await row.expectRevert("guardian cannot unpause early", "guardian", { address: gov, abi: IODGovernorAbi as Abi, functionName: "setBuysPaused", args: [false] }, ["AccessControlUnauthorizedAccount"]);

    // 6. the warp reaches 48 h; the timelock executes; the flag reads false on chain; the ledger row is closed
    await warpBy(ctx, Number(ready - (await nowTs(ctx))) + 5);
    await pushCalendar(ctx, row); await freshen(ctx, ["ETH", "BTC"]);
    row.chain("isOperationReady", await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "isOperationReady", args: [op.id] }), true);
    const exec = await row.send("execute the unpause (owner Safe)", "owner", op.execReq);
    row.chain("isOperationDone", await ctx.pub.readContract({ address: tl, abi: tlAbi, functionName: "isOperationDone", args: [op.id] }), true);
    row.chain("Governor buysPaused after execute", await govPaused(ctx), false);
    for (const r of ledger) r.closed = exec.hash;
    write();
    const closed = parseLedger(await Bun.file(file).text());
    row.chainTrue("both ledger rows closed with the execute tx", closed.length === 2 && closed.every((r) => r.closed === exec.hash), file);
    // 7. buys are back and the holder's tokens are intact
    await buyDirect(ctx, row, "alice", g, U(500), "alice buys 500 USDG after the unpause");
    row.chain("gear still LISTED", ((await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gear", args: [g.id] })) as { status: number }).status, 1);
    row.note(`ledger copy: ${file}; pause ${pause.hash}, schedule ${sched.hash}, execute ${exec.hash}, op ${op.id}`);
  },
};

export const flows: Flow[] = [L01];
