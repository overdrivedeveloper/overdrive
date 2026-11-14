// Parity flows P01 and P02 (todo 22d). P01: the API's account, gears, governor and exit views equal the chain read at the API's
// own block (asOfBlock), for every gear and every funded fork account. P02: the indexer follows anvil_revert and a 3-block reorg.
import { type Address } from "viem";
import { IODGearRegistryAbi, IODGovernorAbi, IODMinterAbi } from "../../../src/abi";
import { addressOf } from "../lib";
import {
  Row, GEAR, apiGet, buyDirect, ensureCapital, ensureGear, freshen, fundRole, pollApi, tokenOf, U, type Ctx, type Flow, type Row,
} from "./harness";

const lc = (s: string) => s.toLowerCase();
interface Meta { asOfBlock: string }

async function parity(ctx: Ctx, row: Row): Promise<void> {
  const gov = ctx.c.ODGovernor!;
  const [gearsApi, govApi, exitApi] = await Promise.all([
    apiGet<Meta & { gears: { id: string; symbol: string; token: string; nf: string; cap: string; status: string; buyable: boolean }[] }>("/v1/gears"),
    apiGet<Meta & { freeCashUsdg: string; buysPaused: boolean; equityWad: string; exitReserve: { balanceUsdg: string; floorUsdg: string } }>("/v1/governor"),
    apiGet<Meta & { reserveUsdg: string; floorUsdg: string }>("/v1/exit"),
  ]);
  const at = (m: Meta) => ({ blockNumber: BigInt(m.asOfBlock) });
  // gears
  for (const g of gearsApi.gears) {
    const b = at(gearsApi);
    const ns = (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "normState", args: [g.id as `0x${string}`], ...b })) as { nf: bigint };
    const cfg = (await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi, functionName: "gear", args: [g.id as `0x${string}`], ...b })) as { capUsdWad: bigint; status: number };
    // the API projects nf forward from the last accrual to its own wall-clock "now" (gear-view projectNf); the stored chain nf is
    // as of the last accrual, so the two differ by at most the toll of the gap: compare within 1e-6 relative
    row.apiWithin(`${g.symbol} nf (as of block ${gearsApi.asOfBlock}, projected by the API)`, BigInt(g.nf), ns.nf, ns.nf / 1_000_000n + 1n);
    // BUG-LIST-CAP: GearListed carries no cap or spread and listGear emits no GearParamsSet, so the indexed gear keeps cap 0 and
    // spread 0 until the first params change (the API then shows an uncapped, zero-spread gear). Contract-side fix: emit it.
    await row.known("BUG-LIST-CAP", () => row.api(`${g.symbol} cap`, g.cap, (cfg.capUsdWad / 10n ** 12n).toString()));
    row.api(`${g.symbol} status active <=> LISTED`, g.status === "active", cfg.status === 1);
  }
  // governor and exit
  let b = at(govApi);
  const rd = (fn: string) => ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: fn, ...b } as never) as Promise<bigint>;
  row.api("governor freeCashUsdg", govApi.freeCashUsdg, (await rd("freeCash")).toString());
  // the reserve moves with every trade and the floor with cached equity: the API reads them a moment after its stated block
  const near = (label: string, got: string, want: bigint) => row.apiWithin(label, BigInt(got), want, want / 10_000n + 1n);
  near("governor exit reserve balance", govApi.exitReserve.balanceUsdg, await rd("exitReserve"));
  near("governor exit reserve floor", govApi.exitReserve.floorUsdg, await rd("exitReserveFloor"));
  row.api("governor buysPaused", govApi.buysPaused, ((await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "buysPaused", ...b })) as readonly [boolean, string])[0]);
  b = at(exitApi);
  near("exit reserveUsdg", exitApi.reserveUsdg, await rd("exitReserve"));
  near("exit floorUsdg", exitApi.floorUsdg, await rd("exitReserveFloor"));
  // accounts: every fork account that can hold gears
  let held = 0;
  for (const role of ["alice", "bob", "carol", "agentOwner", "backer", "backer2", "spare1", "spare2"] as const) {
    const who = addressOf(role);
    const acct = await apiGet<Meta & { balances: { gear: string; token: string; balance: string }[] }>(`/v1/account/${who}`);
    for (const g of gearsApi.gears) {
      const chain = (await ctx.pub.readContract({ address: g.token as Address, abi: (await import("../lib")).erc20Abi, functionName: "balanceOf", args: [who], blockNumber: BigInt(acct.asOfBlock) })) as bigint;
      const got = BigInt(acct.balances.find((x) => lc(x.token) === lc(g.token))?.balance ?? "0");
      if (chain > 0n || got > 0n) held++;
      row.api(`${role} ${g.symbol} balance (block ${acct.asOfBlock})`, got.toString(), chain.toString());
    }
  }
  row.note(`${gearsApi.gears.length} gears, ${held} non-zero account balances compared at the API's own block`);
}

const P01: Flow = {
  id: "P01", area: "parity", kind: "success", name: "API /v1/account, /v1/gears, /v1/governor, /v1/exit equal the chain at the API's block after every earlier flow",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    // the indexer may still be catching up after the last row: retry the whole comparison for up to 30 s, report the last failure
    let last: unknown;
    for (const end = Date.now() + 30_000; ; await Bun.sleep(2000)) {
      const attempt = new Row(ctx, row.spec);
      try { await parity(ctx, attempt); if (attempt.deferred.length === 0) { await parity(ctx, row); return; } last = new Error(attempt.deferred.join(" | ")); } catch (e) { last = e; }
      if (Date.now() > end) { await parity(ctx, row); throw last; }
    }
  },
};

const P02: Flow = {
  id: "P02", area: "parity", kind: "success", name: "indexer survives anvil_revert and a 3-block reorg: account rows equal the chain after each",
  async run(row, ctx) {
    await ensureCapital(ctx, row);
    const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
    const who = await fundRole(ctx, "alice", 1_000_000);
    await freshen(ctx, ["ETH", "BTC"]);
    const sym = (await apiGet<{ gears: { id: string; symbol: string }[] }>("/v1/gears")).gears.find((x) => lc(x.id) === lc(g.id))!.symbol;
    const apiBal = async () => BigInt((await apiGet<{ balances: { gear: string; balance: string }[] }>(`/v1/account/${who}`)).balances.find((x) => x.gear === sym)?.balance ?? "0");
    const settle = async (label: string) => {
      const want = await tokenOf(ctx, g.token, who);
      const got = await pollApi(apiBal, (v) => v === want);
      row.api(`${label}: API balance equals chain`, got, want);
    };
    await settle("baseline");
    const base = await tokenOf(ctx, g.token, who);
    const snap = await ctx.test.snapshot();
    await buyDirect(ctx, row, "alice", g, U(500), "buy 500 USDG on the branch that will be reverted");
    await ctx.test.mine({ blocks: 3 });
    await settle("after the branch tx plus 3 blocks");
    const branchHead = await ctx.pub.getBlockNumber();
    await ctx.test.revert({ id: snap });
    row.chain("chain balance back to baseline after anvil_revert", await tokenOf(ctx, g.token, who), base);
    const gone = await ctx.pub.getTransactionReceipt({ hash: row.txs[row.txs.length - 1]!.hash as `0x${string}` }).then(() => false, () => true);
    row.chainTrue(`the reverted branch tx is gone (head was ${branchHead})`, gone, "receipt still exists");
    await ctx.test.mine({ blocks: 3 });
    await freshen(ctx, ["ETH", "BTC"]);
    await settle("after revert and 3 replacement blocks (reorg)");
    await buyDirect(ctx, row, "alice", g, U(700), "buy 700 USDG on the replacement branch");
    await ctx.test.mine({ blocks: 2 });
    await settle("after a different tx on the new branch");
    // identical rows: the account read twice in a row is the same, and the API head never ran ahead of the chain
    const a1 = await apiGet<Meta>(`/v1/account/${who}`);
    row.chainTrue("API block is not ahead of the chain head", BigInt(a1.asOfBlock) <= (await ctx.pub.getBlockNumber()), a1.asOfBlock);
  },
};

export const flows: Flow[] = [P01, P02];
