// Governor rows G03 and G04 (todo 22c). G01 and G02 (donations) are in first-money.ts.
import { readFileSync } from "node:fs";
import { IODGearRegistryAbi, IODGovernorAbi, IODMinterAbi, IODOracleGuardAbi } from "../../../src/abi";
import { addressOf, FORK_DIR } from "../lib";
import { POWER_OF } from "./harness";
import {
  GEAR, buyDirect, ensureCapital, ensureGear, formulaValueOf, freshen, fundRole, sellDirect, tokenOf, U, apiGet, pollApi, nowTs,
  type Abi, type Ctx, type Flow, type GearInfo, type Row,
} from "./harness";
import { MCKR_PRICE, moveMckr, resetMckr } from "./backers";
import { sql } from "./liquidation";
import { bytes32Text } from "../../../src/indexer/units";

const WAD = 10n ** 18n;
const gov = (ctx: Ctx) => ctx.c.ODGovernor!;
const read = <T,>(ctx: Ctx, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  ctx.pub.readContract({ address: gov(ctx), abi: IODGovernorAbi, functionName, args, ...(blockNumber ? { blockNumber } : {}) } as never) as Promise<T>;
const totalSupply = (ctx: Ctx, token: `0x${string}`, blockNumber?: bigint) => ctx.pub.readContract({ address: token, abi: [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "totalSupply", ...(blockNumber ? { blockNumber } : {}) } as never) as Promise<bigint>;

const G04: Flow = {
  id: "G04", area: "governor", kind: "success",
  name: "IODGovernor.exposure(ETH) equals the sum over gears (delta p x V x net, gamma p(p-1) x V x net) and the indexed governor_ledger row equals the getter at its block",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const gears = [await ensureGear(ctx, row, "ETH", null, GEAR.CRUISE), await ensureGear(ctx, row, "ETH", null, GEAR.SPORT), await ensureGear(ctx, row, "ETH", null, GEAR.ECO)];
    await fundRole(ctx, "alice", 300_000);
    await freshen(ctx, ["ETH"]);
    for (const g of gears) await buyDirect(ctx, row, "alice", g, U(20_000), `alice buys ${g.key}`);
    await freshen(ctx, ["ETH"]);
    const market = gears[0]!.marketA;
    // every read is pinned to one block: the getter values each gear at normState (NF as if accrued at that block, so it
    // includes the toll since the last Accrued event) and the live guard price, and service transactions keep mining
    // between reads, so the sum must see the same block as the getter
    const blockNumber = await ctx.pub.getBlockNumber();
    const ids = (await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi, functionName: "gearsOfMarket", args: [market], blockNumber })) as `0x${string}`[];
    const p = ((await ctx.pub.readContract({ address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi, functionName: "read", args: [market], blockNumber })) as { p: bigint }).p;
    let delta = 0n, gamma = 0n, open = 0n;
    const POW: Record<number, bigint> = { 0: 15n * WAD / 10n, 1: 2n * WAD, 2: 3n * WAD, 3: WAD / 2n, 4: -WAD };
    for (const id of ids) {
      const cfg = (await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi, functionName: "gear", args: [id], blockNumber })) as { gear: number; token: `0x${string}`; marketA: `0x${string}`; marketB: `0x${string}` };
      const net = (await totalSupply(ctx, cfg.token, blockNumber)) - (await read<bigint>(ctx, "backerDebt", [id], blockNumber));
      if (net === 0n) continue;
      // the getter sums every gear listed under the market, pairs included (ODGovernorRisk.exposure): a pair is valued at the
      // guard's ratio price and counts with -power when this market is its denominator
      const isPair = !/^0x0+$/.test(cfg.marketB);
      const px = isPair ? ((await ctx.pub.readContract({ address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi, functionName: "readRatio", args: [cfg.marketA, cfg.marketB], blockNumber })) as { p: bigint }).p : p;
      const info: GearInfo = { id, token: cfg.token, key: id, gear: cfg.gear, marketA: cfg.marketA, marketB: (isPair ? cfg.marketB : "0x") as never };
      const nf = ((await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "normState", args: [id], blockNumber })) as { nf: bigint }).nf;
      const v = await formulaValueOf(ctx, info, px, nf);
      const val = net * v / WAD;
      const pw = isPair && cfg.marketB.toLowerCase() === market.toLowerCase() ? -POW[cfg.gear]! : POW[cfg.gear]!;
      delta += pw * val / WAD;
      gamma += (pw * (pw - WAD) / WAD) * val / WAD;
      open += val < 0n ? -val : val;
    }
    const [d, gm, o] = await read<readonly [bigint, bigint, bigint]>(ctx, "exposure", [market], blockNumber);
    // 1e-6 of the open value: at one block the only gap left is per-gear rounding (the getter rounds up for a net long, this
    // sum rounds down), a few wei per gear, so 1e-6 is wide headroom and still catches any real mis-sum.
    const tol = open / 1_000_000n + 1_000n;
    row.chainWithin("exposure delta == sum over gears", d, delta, tol);
    row.chainWithin("exposure gamma == sum p(p-1) x V x net", gm, gamma, tol);
    row.chainWithin("exposure open value == sum |net| x V", o, open, tol);
    row.chainTrue("book is not empty", open > 0n, open);
    // the indexed ledger row, compared with the getter at that row's own block
    const q = sql();
    try {
      const t0 = Number(await ctx.pub.getBlockNumber());
      const rows = await pollApi(() => q`select block::text as block, delta::text as delta, gamma::text as gamma from governor_ledger where underlying = 'ETH' and block >= ${t0.toString()} order by block desc limit 1`, (r) => r.length > 0, 90_000)
        .catch(() => q`select block::text as block, delta::text as delta, gamma::text as gamma from governor_ledger where underlying = 'ETH' order by block desc limit 1`);
      const r0 = rows[0]!;
      const [cd, cg] = await read<readonly [bigint, bigint, bigint]>(ctx, "exposure", [market], BigInt(r0.block));
      row.apiWithin("governor_ledger delta == getter at its block (USDG units)", BigInt(r0.delta), cd / 10n ** 12n, 2n + BigInt(r0.delta) / 1_000_000n);
      row.apiWithin("governor_ledger gamma == getter at its block", BigInt(r0.gamma), cg / 10n ** 12n, 2n + BigInt(r0.gamma) / 1_000_000n);
    } finally { await q.end({ timeout: 2 }); }
    void tokenOf; void sellDirect; void apiGet; void addressOf; void readFileSync; void FORK_DIR; void POWER_OF; void nowTs;
  },
};

const G03: Flow = {
  id: "G03", area: "governor", kind: "success",
  name: "a real 20 percent loss with unchanged supply trips the drawdown pause: the contract and the monitor's indexed view agree",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await ensureGear(ctx, row, "MCKR", null, GEAR.RACE);
    await fundRole(ctx, "carol", 5_000_000);
    await resetMckr(ctx, row);
    const supply0 = await read<bigint>(ctx, "totalSupply");
    // size the exposure so three +14 percent steps cost the Governor well over 20 percent of its equity
    let bought = 0n;
    for (const usd of [1_500_000, 900_000, 500_000, 250_000, 100_000]) {
      try { await buyDirect(ctx, row, "carol", g, U(usd), `carol buys ${usd} USDG of MCKR-RACE`); bought = U(usd); break; } catch (e) { row.note(`buy ${usd} refused: ${(e as Error).message.slice(0, 80)}`); }
    }
    row.chainTrue("a position was opened", bought > 0n);
    const eq0 = await read<bigint>(ctx, "equity");
    const sp0 = await read<bigint>(ctx, "sharePriceWad");
    let p = MCKR_PRICE, drop = 0n;
    for (let i = 0; i < 4 && drop < 2200n; i++) {
      p = (p * 114n) / 100n;
      await moveMckr(ctx, row, p, `MCKR price +14 percent (step ${i + 1})`);
      await freshen(ctx, ["ETH", "MCKR"]);
      const sp = await read<bigint>(ctx, "sharePriceWad");
      drop = sp0 > sp ? ((sp0 - sp) * 10_000n) / sp0 : 0n;
      row.note(`share price down ${drop} bps after step ${i + 1}`);
    }
    row.chain("gear-holder supply side unchanged: Governor share supply", await read<bigint>(ctx, "totalSupply"), supply0);
    row.chainTrue("a real loss of at least 20 percent of the share price", drop >= 2000n, `${drop} bps`);
    const eq1 = await read<bigint>(ctx, "equity");
    row.chainTrue("equity fell", eq1 < eq0, `${eq0} -> ${eq1}`);
    const [peak, now, tripped] = await read<readonly [bigint, bigint, boolean]>(ctx, "drawdown");
    row.chain("contract drawdown() tripped", tripped, true);
    const [paused, reason] = await read<readonly [boolean, string]>(ctx, "buysPaused");
    row.chain("contract buysPaused", paused, true);
    row.chainTrue("pause reason is DRAWDOWN", bytes32Text(reason) === "DRAWDOWN", reason);
    row.note(`peak ${peak} now ${now}`);
    // the indexed view (what the crank monitor cross-checks) sees the same drop
    const q = sql();
    try {
      const rows = await pollApi(() => q`select (select equity::numeric from governor_ledger order by ts desc limit 1) as latest, (select max(equity::numeric) from governor_ledger) as peak`, (r) => {
        const x = r[0]; return !!x && x.peak && x.latest && (Number(x.peak) - Number(x.latest)) / Number(x.peak) >= 0.1;
      }, 120_000).catch(() => null);
      row.chainTrue("indexed governor_ledger equity is at least 10 percent under its peak (the monitor's confirm threshold)", !!rows, "no indexed drop seen in 120 s");
    } finally { await q.end({ timeout: 2 }); }
    row.api("API /v1/governor reports buys paused", ((await apiGet<{ buysPaused?: boolean }>("/v1/governor")).buysPaused), true);
    // recovery: the price returns, the pause clears by itself (no latch)
    await resetMckr(ctx, row);
    await freshen(ctx, ["ETH", "MCKR"]);
    const [, , again] = await read<readonly [bigint, bigint, boolean]>(ctx, "drawdown");
    row.chain("drawdown clears when the share price recovers", again, false);
    void sellDirect; void U;
  },
};

export const flows: Flow[] = [G04, G03];
export const prepare = async (ctx: Ctx) => { await ensureCapital(ctx, null); };
