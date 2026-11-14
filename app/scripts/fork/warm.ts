// Warm the fork right after anvil starts (todo 22 R2): the free public RPC keeps about 10 minutes of state, so every piece
// of MUTABLE mainnet state the run reads (USDG, the v4 PoolManager, StateView, V4Quoter, Chainlink feeds, Pyth, Stock
// Tokens, the v3 reference pools, the USDG holder) is read now through anvil -> rpc cache, and lands on disk and in anvil's
// state. A fork restarted hours later is then answered from the cache. Reverting reads are expected and ignored.
//
//   bun scripts/fork/warm.ts [deploy-config.json]     default: contracts/script/config/fork.json
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { assertFork, loadForkConfig, ROOT } from "./lib";

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)", "function oraclePaused() view returns (bool)", "function paused() view returns (bool)",
  "function isFrozen(address) view returns (bool)", "function symbol() view returns (string)", "function transfer(address,uint256) returns (bool)",
]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)",
  "function observe(uint32[]) view returns (int56[],uint160[])", "function token0() view returns (address)", "function token1() view returns (address)",
]);
const pythAbi = parseAbi(["function getPriceUnsafe(bytes32) view returns ((int64,uint64,int32,uint256))", "function getValidTimePeriod() view returns (uint256)"]);

export interface WarmCall { to: Address; data: Hex; from?: Address; label: string }
interface BaseCfg {
  external: Record<string, string>;
  markets: { symbol: string; feed: string; stockAsset: string; twapPool: string; pythId: string; twapWindow?: number }[];
}
const ZERO = "0x0000000000000000000000000000000000000000";
const call = (label: string, to: string, abi: readonly unknown[], functionName: string, args: unknown[] = [], from?: Address): WarmCall => ({
  label, to: getAddress(to), data: (encodeFunctionData as (x: unknown) => Hex)({ abi, functionName, args }), ...(from ? { from } : {}),
});

/** Every read the warm-up makes (pure; the test checks the listed state is all here). */
export function warmCalls(cfg: BaseCfg, holder: Address): WarmCall[] {
  const e = cfg.external;
  const usdg = e.usdg!;
  const out: WarmCall[] = [];
  for (const fn of ["totalSupply", "decimals", "paused"]) out.push(call(`USDG ${fn}`, usdg, tokenAbi, fn));
  for (const who of [e.poolManager!, holder]) {
    out.push(call(`USDG balanceOf ${who}`, usdg, tokenAbi, "balanceOf", [who]));
    out.push(call(`USDG isFrozen ${who}`, usdg, tokenAbi, "isFrozen", [who]));
  }
  if (holder !== ZERO) out.push(call("USDG holder transfer (simulated)", usdg, tokenAbi, "transfer", [e.poolManager, 1n], holder));
  if (e.pythCore) out.push(call("Pyth validTimePeriod", e.pythCore, pythAbi, "getValidTimePeriod"));
  for (const m of cfg.markets) {
    for (const fn of ["latestRoundData", "decimals", "description"]) out.push(call(`${m.symbol} feed ${fn}`, m.feed, feedAbi, fn));
    if (m.stockAsset && m.stockAsset !== ZERO) {
      for (const fn of ["totalSupply", "decimals", "uiMultiplier", "oraclePaused", "paused", "symbol"]) out.push(call(`${m.symbol} token ${fn}`, m.stockAsset, tokenAbi, fn));
      out.push(call(`${m.symbol} token balanceOf PoolManager`, m.stockAsset, tokenAbi, "balanceOf", [e.poolManager]));
    }
    if (m.twapPool && m.twapPool !== ZERO) {
      for (const fn of ["slot0", "liquidity", "token0", "token1"]) out.push(call(`${m.symbol} pool ${fn}`, m.twapPool, poolAbi, fn));
      out.push(call(`${m.symbol} pool observe`, m.twapPool, poolAbi, "observe", [[m.twapWindow ?? 1800, 0]]));
    }
    if (e.pythCore && m.pythId && !/^(0x)?0+$/.test(m.pythId)) {
      out.push(call(`${m.symbol} pyth`, e.pythCore, pythAbi, "getPriceUnsafe", [`0x${m.pythId.replace(/^0x/, "")}`]));
    }
  }
  return out;
}

/** Contracts whose code (and nothing else) the run needs. */
export function warmCode(cfg: BaseCfg, codeOnly: readonly string[]): Address[] {
  const e = cfg.external;
  return [e.usdg, e.poolManager, e.stateView, e.v4Quoter, e.pythCore, e.v3Factory, ...codeOnly].filter((a): a is string => !!a && a !== ZERO).map((a) => getAddress(a));
}

export async function warm(cfgPath = join(ROOT, "contracts/script/config/fork.json")): Promise<{ calls: number; reverted: number; code: number }> {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as BaseCfg;
  const fork = loadForkConfig();
  const { pub } = await assertFork();
  const code = warmCode(cfg, fork.warm.codeOnly);
  for (const a of code) await pub.getCode({ address: a });
  let reverted = 0;
  const calls = warmCalls(cfg, getAddress(fork.usdgHolder));
  for (const c of calls) {
    try { await pub.call({ to: c.to, data: c.data, ...(c.from ? { account: c.from } : {}) }); } catch { reverted++; }
  }
  return { calls: calls.length, reverted, code: code.length };
}

if (import.meta.main) {
  const started = Date.now();
  const r = await warm(process.argv[2]);
  console.log(`warm: ${r.code} contracts and ${r.calls} reads (${r.reverted} reverted, expected for unset Pyth ids) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
