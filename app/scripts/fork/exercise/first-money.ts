// First-money rows G01, G02 (todo 22 R12) against the REAL deployed system: a donation by plain transfer into an empty vault
// must not pause anything, skew shares or count as equity (VAULT-1). G03 (a real 20 percent loss trips the pause) lives in
// governor.ts because it needs a funded Governor and a mock market. Run these BEFORE any area that calls ensureCapital.
import { IODBackerAbi, IODGovernorAbi, IODInsuranceAbi } from "../../../src/abi";
import { addressOf, asTimelock, erc20Abi } from "../lib";
import { GEAR, approveMinter, ensureGear, freshen, fundRole, tokenOf, usdgOf, U, type Abi, type Ctx, type Flow, type Row } from "./harness";
import { walletFor } from "../lib";

export const WAD = 10n ** 18n;

async function govDeposit(ctx: Ctx, row: Row, label: string, usdg: bigint): Promise<bigint> {
  const who = addressOf("spare2");
  const gov = ctx.c.ODGovernor!;
  const before = (await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "balanceOf", args: [who] })) as bigint;
  await freshen(ctx, ["ETH", "BTC"]);
  await row.send(label, "spare2", { address: gov, abi: IODGovernorAbi as Abi, functionName: "deposit", args: [usdg, who], gas: 3_000_000n });
  return ((await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "balanceOf", args: [who] })) as bigint) - before;
}
const eq = async (ctx: Ctx) => (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "equity" })) as bigint;
const paused = async (ctx: Ctx) => (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "buysPaused" })) as readonly [boolean, string];
const dd = async (ctx: Ctx) => (await ctx.pub.readContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "drawdown" })) as readonly [bigint, bigint, boolean];

const G01: Flow = {
  id: "G01", area: "first-money", kind: "success",
  name: "donation by plain transfer into the empty Governor, then deposits of 4, 2 and 4,000,000 USDG: no pause, fair shares, donation not equity (VAULT-1)",
  async run(row, ctx) {
    const gov = ctx.c.ODGovernor!;
    const supply0 = (await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "totalSupply" })) as bigint;
    if (supply0 !== 0n) row.blocked(`the Governor is not empty (supply ${supply0}); run first-money on a fresh reset.sh stack before holders`);
    const donor = await fundRole(ctx, "spare1", 5_000);
    void donor;
    const DON = U(1000);
    const held0 = await usdgOf(ctx, gov); // a rerun after a failed attempt finds an earlier donation: assert the delta
    await row.send("donate 1000 USDG by plain transfer into the empty Governor", "spare1", { address: ctx.usdg, abi: erc20Abi as Abi, functionName: "transfer", args: [gov, DON] });
    row.chain("Governor holds the donation", (await usdgOf(ctx, gov)) - held0, DON);
    row.chain("donation is not equity", await eq(ctx), 0n);
    row.chain("tracked cash ignores the donation", (await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "freeCash" })) as bigint, 0n);
    // seeding is by deposit only: allow one depositor through the timelock
    const who = addressOf("spare2");
    await fundRole(ctx, "spare2", 4_100_000);
    await row.send("setDepositor spare2 (timelock)", "timelock", { address: gov, abi: IODGovernorAbi as Abi, functionName: "setDepositor", args: [who, true] });
    await approveMinter(ctx, row, "spare2", ctx.usdg, gov);
    const s1 = await govDeposit(ctx, row, "deposit 4 USDG into the empty Governor", U(4));
    row.chainTrue("first deposit minted shares", s1 > 0n, s1);
    row.chain("equity after 4 USDG deposit is the deposit only (no donation)", await eq(ctx), 4n * WAD);
    row.chain("no buy pause after the tiny first deposit", (await paused(ctx))[0], false);
    row.chain("no drawdown trip after the tiny first deposit", (await dd(ctx))[2], false);
    const s2 = await govDeposit(ctx, row, "deposit 2 USDG", U(2));
    row.chainWithin("2 USDG mints half the shares of 4 USDG (fair shares)", s2 * 2n, s1, s1 / 1_000_000n + 2n);
    row.chain("equity is 6 USDG", await eq(ctx), 6n * WAD);
    row.chain("no buy pause after tiny deposits", (await paused(ctx))[0], false);
    const s3 = await govDeposit(ctx, row, "deposit 4,000,000 USDG", U(4_000_000));
    row.chainWithin("4,000,000 USDG mints in proportion (6 USDG : s1+s2 shares)", s3 * 6n, (s1 + s2) * 4_000_000n, ((s1 + s2) * 4_000_000n) / 100_000n);
    row.chain("equity is deposits only, the 1000 USDG donation is not counted", await eq(ctx), 4_000_006n * WAD);
    const [peak, now, tripped] = await dd(ctx);
    row.chain("no drawdown trip after the large deposit", tripped, false);
    row.chainWithin("share price within 1 part per million of its peak", now, peak, peak / 1_000_000n + 1n);
    row.chain("no buy pause after the large deposit", (await paused(ctx))[0], false);
    // the donation is recoverable only to the insurance fund, by skim (admin), never to equity
    const ins = ctx.c.ODInsurance!;
    const insBefore = await usdgOf(ctx, ins);
    const toSkim = (await usdgOf(ctx, gov)) - (await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "freeCash" }) as bigint) - ((await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "exitReserve" })) as bigint);
    await row.send("skim (timelock): USDG above tracked cash goes to insurance", "timelock", { address: gov, abi: IODGovernorAbi as Abi, functionName: "skim", args: [] });
    row.chain("insurance received exactly the USDG above tracked cash (the donations)", (await usdgOf(ctx, ins)) - insBefore, toSkim);
    row.chainTrue("skimmed amount covers this row's donation", toSkim >= DON, toSkim);
    row.chain("equity unchanged by skim", await eq(ctx), 4_000_006n * WAD);
  },
};

const G02: Flow = {
  id: "G02", area: "first-money", kind: "success",
  name: "donation by plain transfer into the backer module and into the insurance vault: collateral accounting exact, equity unmoved, nothing pauses (VAULT-1)",
  async run(row, ctx) {
    const backer = ctx.c.ODBacker!, ins = ctx.c.ODInsurance!, gov = ctx.c.ODGovernor!;
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    const who = await fundRole(ctx, "backer", 10_000);
    await fundRole(ctx, "spare1", 5_000);
    const vaults0 = (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "vaultCount" })) as bigint;
    const tc0 = (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "totalCollateral" })) as bigint;
    const bal0 = await usdgOf(ctx, backer);
    const eq0 = await eq(ctx);
    const mintPaused0 = (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "mintPaused" })) as boolean;
    const DON = U(777);
    await row.send("donate 777 USDG into the EMPTY backer module by plain transfer", "spare1", { address: ctx.usdg, abi: erc20Abi as Abi, functionName: "transfer", args: [backer, DON] });
    row.chain("backer totalCollateral ignores the donation", (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "totalCollateral" })) as bigint, tc0);
    await approveMinter(ctx, row, "backer", ctx.usdg, backer);
    await row.send("open vault with the 50 USDG minimum", "backer", { address: backer, abi: IODBackerAbi as Abi, functionName: "openVault", args: [g.id, U(50)] });
    const vid = vaults0 + 1n;
    const h = (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "vault", args: [vid] })) as readonly [string, string, bigint, bigint, bigint];
    row.chain("vault collateral is exactly the 50 USDG paid, not the donation", h[2], U(50));
    row.chain("totalCollateral == vault collateral", (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "totalCollateral" })) as bigint, tc0 + U(50));
    await row.send("top up one raw unit (tiny deposit)", "backer", { address: backer, abi: IODBackerAbi as Abi, functionName: "deposit", args: [vid, 1n] });
    row.chain("tiny top-up credited exactly", ((await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "vault", args: [vid] })) as readonly [string, string, bigint, bigint, bigint])[2], U(50) + 1n);
    row.chain("mint pause flag unchanged by the donation", (await ctx.pub.readContract({ address: backer, abi: IODBackerAbi, functionName: "mintPaused" })) as boolean, mintPaused0);
    const before = await usdgOf(ctx, who);
    await row.send("withdraw everything", "backer", { address: backer, abi: IODBackerAbi as Abi, functionName: "withdraw", args: [vid, U(50) + 1n, who] });
    row.chain("owner gets exactly its collateral back, not the donation", (await usdgOf(ctx, who)) - before, U(50) + 1n);
    row.chain("backer still holds the donation plus any earlier balance", await usdgOf(ctx, backer), bal0 + DON);
    // insurance vault
    const ib0 = await usdgOf(ctx, ins);
    await row.send("donate 500 USDG into the insurance vault by plain transfer", "spare1", { address: ctx.usdg, abi: erc20Abi as Abi, functionName: "transfer", args: [ins, U(500)] });
    row.chain("insurance balance() counts the transfer (it is cover, by design)", (await ctx.pub.readContract({ address: ins, abi: IODInsuranceAbi, functionName: "balance" })) as bigint, ib0 + U(500));
    row.chain("Governor equity unchanged by both donations (insurance is never equity)", await eq(ctx), eq0);
    row.chain("no Governor buy pause", (await paused(ctx))[0], false);
    row.chain("no drawdown trip", (await dd(ctx))[2], false);
    void gov; void tokenOf; void walletFor; void asTimelock;
  },
};

export const flows: Flow[] = [G01, G02];
