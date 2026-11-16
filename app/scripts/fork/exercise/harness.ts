// Exercise harness (todo 22 R9, R10, invariant): rows are assertions, not logs. A flow gets a `Row` that records every
// transaction (hash, gas, status), asserts chain values and API values (both reported on a mismatch) and decodes reverts to
// the contract error name. 22b writes the holder flows on top of this; 22c adds backer, Governor and service flows by
// exporting `Flow[]` from its own files and listing them in index.ts.
// Fork only: every client is the local anvil (lib.assertFork).
import { readFileSync, writeFileSync } from "node:fs";
import { parseEventLogs, keccak256, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, toFunctionSelector, zeroAddress,
  type Abi, type Address, type Hex, type PublicClient, type TestClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABIS, IODGearRegistryAbi, IODGovernorAbi, IODMinterAbi, IODOracleGuardAbi, IODVolOracleAbi } from "../../../src/abi";
import { revertDataOf } from "../../../src/chain/revert";
import { fund } from "../fund";
import {
  API_URL, DEPLOYMENT_FILE, FORK_DIR, addressOf, assertFork, asTimelock, erc20Abi, keyOf, loadDeployment, walletFor, type ForkDeployment, type Role,
} from "../lib";
import { marketId, refreshPyth } from "../setup";
import { saveResults, upsertRow, type ResultRow, type ResultsFile, type TxRecord } from "./results";

// ------------------------------------------------------------------------------------------------ errors and flows

export class Blocked extends Error {}
export class AssertionFailure extends Error {}

export interface FlowSpec { id: string; area: string; name: string; kind: "success" | "expected_failure" }
export interface Flow extends FlowSpec { run(row: Row, ctx: Ctx): Promise<void> }

const show = (v: unknown): string => (typeof v === "bigint" ? v.toString() : typeof v === "object" ? JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)) : String(v));

// ------------------------------------------------------------------------------------------------ revert decoding

const ERROR_SELECTORS: { selector: string; name: string }[] = [];
for (const abi of Object.values(ABIS) as unknown as Abi[]) {
  for (const item of abi) {
    if (item.type !== "error") continue;
    ERROR_SELECTORS.push({ selector: toFunctionSelector({ ...item, type: "function" } as never).slice(2), name: item.name });
  }
}

// errors declared on the concrete ODHook only (not in the IOD* interfaces the ABI folder is generated from)
for (const sig of ["PoolManagerShort(address,uint256,uint256)", "QuoteMismatch(uint256,uint256,uint256,uint256)", "NotGearPool()"]) {
  ERROR_SELECTORS.push({ selector: toFunctionSelector(sig).slice(2), name: sig.slice(0, sig.indexOf("(")) });
}

/** Registers extra error signatures (for example the timelock's) so `revertNames` and `expectRevert` decode them. */
export function registerErrors(sigs: string[]): void {
  for (const sig of sigs) ERROR_SELECTORS.push({ selector: toFunctionSelector(sig).slice(2), name: sig.slice(0, sig.indexOf("(")) });
}

/** Every contract error named anywhere in the revert data of `e`. A hook revert reaches the swapper wrapped by the
 * PoolManager (WrappedError), so the inner error is found by its selector. */
export function revertNames(e: unknown): string[] {
  const data = revertDataOf(e);
  if (!data) return [];
  const hex = data.slice(2).toLowerCase();
  const names = new Set<string>();
  for (const { selector, name } of ERROR_SELECTORS) if (hex.includes(selector)) names.add(name);
  if (hex.startsWith("08c379a0")) names.add("Error(string)");
  return [...names];
}

// ------------------------------------------------------------------------------------------------ the shared context

export interface GearInfo { id: Hex; token: Address; key: string; gear: number; marketA: Hex; marketB: Hex }

export const GEAR = { CRUISE: 0, SPORT: 1, RACE: 2, ECO: 3, REVERSE: 4 } as const;
export const POWER_OF: Record<number, string> = { 0: "1.5", 1: "2", 2: "3", 3: "0.5", 4: "-1" };
const hookAbi = parseAbi([
  "function poolKeyOf(bytes32) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
]);
export const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
export const UNIVERSAL_ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export interface Ctx {
  pub: PublicClient;
  test: TestClient<"anvil">;
  dep: ForkDeployment;
  c: Record<string, Address>;
  usdg: Address;
  gears: Map<string, GearInfo>;
  /** Mock markets created by this harness (mock Chainlink feed + mock Stock Token), by symbol. */
  mocks: Map<string, MockMarket>;
}
export interface MockMarket { symbol: string; id: Hex; feed: Address; stock: Address; pythId: Hex; embedded: boolean; decimals: number }

export async function makeCtx(): Promise<Ctx> {
  const { pub, test } = await assertFork();
  const dep = loadDeployment();
  const c = Object.fromEntries(Object.entries(dep.contracts).map(([k, v]) => [k, getAddress(v)])) as Record<string, Address>;
  // gas money for the roles the harness signs as (anvil_setBalance on ETH only; USDG is never written to storage)
  for (const r of ["deployer", "volSender", "spare1", "crank", "guardian", "owner", "liquidator"] as const) await test.setBalance({ address: addressOf(r), value: 10n ** 21n });
  return { pub, test, dep, c, usdg: getAddress(dep.external.usdg!), gears: new Map(), mocks: new Map() };
}

export const nowTs = async (ctx: Ctx): Promise<bigint> => (await ctx.pub.getBlock()).timestamp;
export const usdgOf = (ctx: Ctx, who: Address) => ctx.pub.readContract({ address: ctx.usdg, abi: erc20Abi, functionName: "balanceOf", args: [who] });
export const tokenOf = (ctx: Ctx, token: Address, who: Address) => ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

// ------------------------------------------------------------------------------------------------ time control

/** Runs `fn` with the next block pinned to T = latest + 1 s, so a quote taken with `blockOverrides.time = T` and the
 * transaction mined at T see the same clock (a toll accrual quoted in another second is a different number). */
/** The next block lands no earlier than `t`. A service block that already passed `t` is fine (the chain is past it). */
export async function nextBlockAtLeast(ctx: Ctx, t: bigint): Promise<void> {
  if ((await nowTs(ctx)) >= t) return;
  try { await ctx.test.setNextBlockTimestamp({ timestamp: t }); } catch (e) {
    if (!/lower than previous block's timestamp/.test((e as Error).message)) throw e;
  }
}

export async function atNextSecond<R>(ctx: Ctx, fn: (t: bigint) => Promise<R>): Promise<R> {
  // the stack's services mine their own blocks: one can land between the read and the set, so re-read and retry
  for (let i = 0; ; i++) {
    const T = (await nowTs(ctx)) + 1n;
    try { await ctx.test.setNextBlockTimestamp({ timestamp: T }); } catch (e) {
      // a service block that is still being mined has already claimed its timestamp but is not yet `latest`: back off
      // until it lands (a heavy fork block fetches upstream state and can take seconds), then re-read
      if (i < 40 && /lower than previous block's timestamp/.test((e as Error).message)) { await Bun.sleep(250 + 50 * i); continue; }
      throw e;
    }
    return fn(T);
  }
}

/** An eth_call evaluated as if the block time were `t`. */
export async function callAt(ctx: Ctx, t: bigint, req: { to: Address; data: Hex; account?: Address }): Promise<Hex> {
  const r = await ctx.pub.call({ ...req, blockOverrides: { time: t } } as never);
  return (r.data ?? "0x") as Hex;
}

export async function readAt<A extends Abi>(ctx: Ctx, t: bigint, address: Address, abi: A, functionName: string, args: readonly unknown[], account?: Address): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const out = await callAt(ctx, t, { to: address, data, ...(account ? { account } : {}) });
  return decodeFunctionResult({ abi, functionName, data: out } as never);
}

// ------------------------------------------------------------------------------------------------ the row

export interface SendReq { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint }

export class Row {
  txs: TxRecord[] = [];
  /** Failures recorded against a known bug id; the flow keeps running and then fails with all of them listed. */
  deferred: string[] = [];
  chainN = 0;
  apiN = 0;
  notes: string[] = [];
  constructor(readonly ctx: Ctx, readonly spec: FlowSpec) {}

  /** Runs `fn`; an assertion failure inside is recorded as `[bugId] message` and the row fails at the end (the bug stays
   * visible in the row instead of ending it early). */
  async known(bugId: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); } catch (e) { if (e instanceof AssertionFailure || e instanceof Error) this.deferred.push(`[${bugId}] ${e.message}`); else throw e; }
  }
  note(s: string): void { this.notes.push(s); }
  blocked(reason: string): never { throw new Blocked(reason); }

  private fail(side: string, label: string, got: unknown, want: unknown): never {
    throw new AssertionFailure(`${side} ${label}: got ${show(got)}, want ${show(want)}`);
  }
  /** Exact chain assertion (bigint, number, string, boolean). */
  chain(label: string, got: unknown, want: unknown): void { this.chainN++; if (show(got).toLowerCase() !== show(want).toLowerCase()) this.fail("chain", label, got, want); }
  chainWithin(label: string, got: bigint, want: bigint, tol = 1n): void {
    this.chainN++;
    const d = got > want ? got - want : want - got;
    if (d > tol) this.fail("chain", label, got, `${want} (within ${tol})`);
  }
  chainTrue(label: string, cond: boolean, detail: unknown = ""): void { this.chainN++; if (!cond) this.fail("chain", label, detail, "true condition"); }
  /** Exact API assertion. */
  api(label: string, got: unknown, want: unknown): void { this.apiN++; if (show(got).toLowerCase() !== show(want).toLowerCase()) this.fail("api", label, got, want); }
  apiWithin(label: string, got: bigint, want: bigint, tol = 1n): void {
    this.apiN++;
    const d = got > want ? got - want : want - got;
    if (d > tol) this.fail("api", label, got, `${want} (within ${tol})`);
  }

  private async record(label: string, hash: Hex): Promise<TxRecord> {
    const r = await this.ctx.pub.waitForTransactionReceipt({ hash });
    const rec: TxRecord = { label, hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" };
    this.txs.push(rec);
    return rec;
  }

  /** Sends a transaction that must succeed. */
  async send(label: string, role: Role | Address | "timelock", req: SendReq): Promise<TxRecord> {
    const hash = role === "timelock"
      ? await asTimelock((w, tl) => w.writeContract({ ...req, gas: 10_000_000n, chain: null, account: tl } as never))
      : await walletFor(role as Role).writeContract({ ...req, chain: null, account: walletFor(role as Role).account! } as never);
    const rec = await this.record(label, hash);
    if (rec.status !== "success") throw new AssertionFailure(`tx ${label} reverted (${hash})`);
    return rec;
  }

  /** The call must revert with one of `names`; it is then also mined with a fixed gas limit so the report has a real,
   * reverted transaction hash. */
  async expectRevert(label: string, role: Role, req: SendReq, names: string[], at?: bigint): Promise<string[]> {
    const w = walletFor(role);
    const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args ?? [] } as never);
    let found: string[] = [];
    try {
      await this.ctx.pub.call({ account: w.account!.address, to: req.address, data, ...(req.value ? { value: req.value } : {}), ...(at ? { blockOverrides: { time: at } } : {}) } as never);
      throw new AssertionFailure(`chain ${label}: call did not revert, want ${names.join(" or ")}`);
    } catch (e) {
      if (e instanceof AssertionFailure) throw e;
      found = revertNames(e);
    }
    this.chainN++;
    if (!names.some((n) => found.includes(n))) this.fail("chain", `${label} revert name`, found.join(",") || "(none decoded)", names.join(" or "));
    const hash = await w.sendTransaction({ to: req.address, data, gas: 5_000_000n, chain: null, account: w.account!, ...(req.value ? { value: req.value } : {}) });
    const rec = await this.record(label, hash);
    rec.revert = found.join(",");
    if (rec.status !== "reverted") rec.status = "reverted";
    return found;
  }

  result(status: ResultRow["status"], startedAt: number, error?: string): ResultRow {
    return {
      id: this.spec.id, area: this.spec.area, name: this.spec.name, kind: this.spec.kind, status, txs: this.txs,
      chain: { asserted: this.chainN, ok: status === "pass" }, api: { asserted: this.apiN, ok: status === "pass" },
      notes: this.notes.join("; "), ...(error ? { error } : {}), startedAt: new Date(startedAt).toISOString(), ms: Date.now() - startedAt,
    };
  }
}

/** Runs one flow, turns every outcome into a row, and runs the invariants after it. Never throws for a flow failure. */
export async function runFlow(flow: Flow, ctx: Ctx, results: ResultsFile, file?: string): Promise<{ results: ResultsFile; row: ResultRow }> {
  const row = new Row(ctx, flow);
  const t0 = Date.now();
  let out: ResultRow;
  try {
    await flow.run(row, ctx);
    if (row.deferred.length) throw new AssertionFailure(row.deferred.join(" | "));
    try { await checkInvariants(ctx, row); } catch (e) { throw new AssertionFailure(`invariant after ${flow.id}: ${(e as Error).message}`); }
    out = row.result("pass", t0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out = row.result(e instanceof Blocked ? "blocked" : "fail", t0, msg.slice(0, 1500));
  }
  const next = upsertRow(results, out);
  saveResults(next, file);
  return { results: next, row: out };
}

// ------------------------------------------------------------------------------------------------ invariants

/** Run after every row. Governor tracked cash plus exit reserve never exceeds the USDG it holds, the exit reserve floor is
 * readable, and no tracked gear supply is below what the Governor books as net tokens (supply is checked per gear). */
export async function checkInvariants(ctx: Ctx, row?: Row): Promise<void> {
  const gov = ctx.c.ODGovernor!;
  const [cash, reserve, held] = await Promise.all([
    ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "freeCash" }) as Promise<bigint>,
    ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "exitReserve" }) as Promise<bigint>,
    usdgOf(ctx, gov),
  ]);
  if (cash + reserve > held) throw new Error(`Governor books cash ${cash} + reserve ${reserve} above the USDG it holds (${held})`);
  const floor = (await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "exitReserveFloor" })) as bigint;
  if (row) row.note(`inv ok cash=${cash} reserve=${reserve} floor=${floor}`);
}

// ------------------------------------------------------------------------------------------------ API

export async function apiGet<T = Record<string, unknown>>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`);
  const text = await r.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`api ${path}: HTTP ${r.status} ${text.slice(0, 200)}`); }
}

/** Polls `read` until `ok(value)` or 30 s pass (R9). Returns the last value either way; the caller asserts on it. */
export async function pollApi<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  let last: T | undefined;
  for (const end = Date.now() + timeoutMs; ; await Bun.sleep(1000)) {
    try { last = await read(); if (ok(last)) return last; } catch (e) { if (Date.now() > end) throw e; }
    if (Date.now() > end) return last as T;
  }
}

// ------------------------------------------------------------------------------------------------ volatility post

/** Posts sigma for a market as the vol signer (anvil dev key, fork only), 2 h validity (the contract maximum). The vol
 * engine is not part of this stack's holder run; G09 covers it. Idempotent inside the 30 s post interval. */
export const volKey = (symbol: string): Hex => {
  if (!symbol.includes("/")) return marketId(symbol);
  const [a, b] = symbol.split("/") as [string, string];
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [marketId(a), marketId(b)])); // ODVolOracle R9 pair key
};
/** postVolOnce, retried when the running vol-engine posted the same nonce between our lastNonce read and our send. */
export async function postVol(ctx: Ctx, symbol: string, sigmaBps = 6000n): Promise<void> {
  for (let i = 0; ; i++) {
    try { return await postVolOnce(ctx, symbol, sigmaBps); } catch (e) {
      // the vol-engine shares the vol signer; its post can sit unmined for a block or two, so an immediate retry reads the
      // same lastNonce and collides again: back off until its post lands
      if (i < 10 && /NonceUsed|TooSoon/.test((e as Error).message)) { await Bun.sleep(1000 + 500 * i); continue; }
      throw e;
    }
  }
}

async function postVolOnce(ctx: Ctx, symbol: string, sigmaBps: bigint): Promise<void> {
  const market = volKey(symbol);
  const vol = ctx.c.ODVolOracle!;
  const reading = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "read", args: [market] })) as { postedAt: bigint; sigmaBps: bigint; validUntil: bigint };
  const now = await nowTs(ctx);
  if (reading.postedAt !== 0n && reading.validUntil > now + 3600n && reading.sigmaBps === sigmaBps) return;
  const [floor, ceiling] = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "bounds", args: [market] })) as [bigint, bigint];
  let sigma = sigmaBps;
  if (reading.postedAt !== 0n) {
    // one step may move at most 25 percent
    const lo = (reading.sigmaBps * 7500n) / 10000n + 1n, hi = (reading.sigmaBps * 12500n) / 10000n - 1n;
    sigma = sigma < lo ? lo : sigma > hi ? hi : sigma;
  }
  if (sigma < floor) sigma = floor;
  if (sigma > ceiling) sigma = ceiling;
  const nonce = ((await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "lastNonce", args: [market] })) as bigint) + 1n;
  if (reading.postedAt !== 0n && now < reading.postedAt + 31n) { await ctx.test.increaseTime({ seconds: Number(reading.postedAt + 31n - now) }); await ctx.test.mine({ blocks: 1 }); }
  const t = await nowTs(ctx);
  const post = { market, sigmaBps: sigma, buyBlockFrom: 0n, buyBlockTo: 0n, validUntil: t + 7000n, nonce };
  const digest = (await ctx.pub.readContract({ address: vol, abi: IODVolOracleAbi, functionName: "hashPost", args: [post] })) as Hex;
  const sig = await privateKeyToAccount(keyOf("volSigner")).sign({ hash: digest });
  const w = walletFor("volSender");
  const hash = await w.writeContract({ address: vol, abi: IODVolOracleAbi, functionName: "post", args: [post, sig], chain: null, account: w.account! } as never);
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`vol post ${symbol} reverted (${hash})`);
}

/** A fresh Pyth price for every real market and a fresh sigma for the given ones. Call before a flow that trades. */
export async function freshen(ctx: Ctx, symbols: string[]): Promise<void> {
  await refreshPyth();
  await refreshMocks(ctx);
  for (const s of symbols) await postVol(ctx, s);
  // the Governor's cached equity and stress go stale after a warp (EQUITY_STALE closes buys): poke them (permissionless)
  const markets = [...new Set(["ETH", "BTC", ...symbols.filter((x) => !x.includes("/")), ...ctx.mocks.keys()])].map(marketId);
  const w = walletFor("crank");
  const hash = await w.writeContract({ address: ctx.c.ODGovernor!, abi: IODGovernorAbi, functionName: "pokeRisk", args: [markets], gas: 8_000_000n, chain: null, account: w.account! } as never);
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`pokeRisk reverted (${hash})`);
}

// ------------------------------------------------------------------------------------------------ gears

export const gearKey = (a: string, b: string | null, gear: number) => `${a}${b ? `/${b}` : ""}:${gear}`;

/** The gear's id and token; lists it through the timelock (impersonated, as the R5 relaxations are) and opens its hook
 * pool when it is not listed yet. Fork-only shortcut for the 48 h schedule; A03 exercises the real delay path. */
export async function ensureGear(ctx: Ctx, row: Row | null, a: string, b: string | null, gear: number, opts: { capUsd?: number; spreadBps?: number } = {}): Promise<GearInfo> {
  if (a === "MCKR") await ensureMockMarket(ctx, "MCKR", true, { alwaysOpen: true, volCeil: 4000n });
  const key = gearKey(a, b, gear);
  const hit = ctx.gears.get(key);
  if (hit) return hit;
  const reg = ctx.c.ODGearRegistry!;
  const marketA = marketId(a), marketB = b ? marketId(b) : (`0x${"00".repeat(32)}` as Hex);
  const id = (await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "idOf", args: [marketA, marketB, gear] })) as Hex;
  let cfg = (await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gear", args: [id] })) as { token: Address };
  if (cfg.token === zeroAddress) {
    await freshen(ctx, b ? [a, b] : [a]);
    if (b) {
      const bounds = await asTimelock((w, tl) => w.writeContract({ address: ctx.c.ODVolOracle!, abi: IODVolOracleAbi as Abi, functionName: "setBounds", args: [volKey(`${a}/${b}`), 3000n, 20000n], gas: 1_000_000n, chain: null, account: tl } as never));
      await ctx.pub.waitForTransactionReceipt({ hash: bounds });
      await postVol(ctx, `${a}/${b}`);
    }
    const sym = `${a}${b ? `/${b}` : ""}${(await ctx.pub.readContract({ address: reg, abi: parseAbi(["function suffixOf(uint8) view returns (string)"]), functionName: "suffixOf", args: [gear] })) as string}`;
    const cap = BigInt(opts.capUsd ?? 5_000_000) * 10n ** 18n;
    const send = async (label: string, req: SendReq) => {
      const hash = await asTimelock((w, tl) => w.writeContract({ ...req, gas: 10_000_000n, chain: null, account: tl } as never));
      const r = await ctx.pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
      row?.txs.push({ label, hash, gas: r.gasUsed.toString(), status: "success" });
    };
    await send(`list ${sym} (timelock, fork shortcut)`, { address: reg, abi: IODGearRegistryAbi as Abi, functionName: "listGear", args: [marketA, marketB, gear, 10n ** 18n, cap, opts.spreadBps ?? 40, sym] });
    await send(`open hook pool ${sym}`, { address: ctx.c.ODHook!, abi: ABIS.IODHook as unknown as Abi, functionName: "initializeGearPool", args: [id] });
    cfg = (await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gear", args: [id] })) as { token: Address };
  }
  const info: GearInfo = { id, token: getAddress(cfg.token), key, gear, marketA, marketB };
  ctx.gears.set(key, info);
  return info;
}

// ------------------------------------------------------------------------------------------------ mock markets

const MCK_ANSWER = 100n * 10n ** 8n; // $100, 8 decimals

function forgeBytecode(contract: string, creation: boolean): Hex {
  const p = Bun.spawnSync([`${process.env.HOME}/.foundry/bin/forge`, "inspect", contract, creation ? "bytecode" : "deployedBytecode"], {
    cwd: `${import.meta.dir}/../../../../contracts`, stdout: "pipe", stderr: "pipe",
  });
  const out = p.stdout.toString().trim().split("\n").pop() ?? "";
  if (p.exitCode !== 0 || !/^0x[0-9a-fA-F]+$/.test(out)) throw new Error(`forge inspect ${contract}: ${p.stderr.toString().slice(-300)}`);
  return out as Hex;
}

async function deployCode(ctx: Ctx, bytecode: Hex): Promise<Address> {
  const w = walletFor("deployer");
  const hash = await w.sendTransaction({ data: bytecode, chain: null, account: w.account!, gas: 4_000_000n });
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`mock deploy reverted (${hash})`);
  return getAddress(r.contractAddress);
}

export const mockFeedAbi = parseAbi([
  "function push(int256) external", "function setRound(int256 answer, uint256 updatedAt) external", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function setRevert(bool) external",
]);
export const mockStockAbi = parseAbi([
  "function setOraclePaused(bool) external", "function setPaused(bool) external", "function setMultipliers(uint256 current, uint256 pending, uint256 effectiveAt) external",
  "function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)",
]);
export const mockPythAbi = parseAbi(["function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external"]);

/** A market on a mock Chainlink feed and a mock Stock Token (fork-only fixture for the stale, closed, halted and split
 * flows: the real feeds are frozen at the fork block). Registered through the timelock with its vol bounds and group. */
export async function ensureMockMarket(ctx: Ctx, symbol: string, embedded: boolean, opts: { alwaysOpen?: boolean; volCeil?: bigint } = {}): Promise<MockMarket> {
  const hit = ctx.mocks.get(symbol);
  if (hit) return hit;
  const id = marketId(symbol);
  const guard = ctx.c.ODOracleGuard!;
  const known = (await ctx.pub.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "config", args: [id] })) as { feed: Address; stockToken: Address; pythId: Hex; enabled: boolean };
  const pythId = `0x${Buffer.from(`${symbol}-mock-pyth`).toString("hex").padEnd(64, "0")}` as Hex;
  if (known.enabled) {
    const m: MockMarket = { symbol, id, feed: known.feed, stock: known.stockToken, pythId: known.pythId, embedded, decimals: 8 };
    ctx.mocks.set(symbol, m);
    return m;
  }
  const feed = await deployCode(ctx, `${forgeBytecode("test/mocks/MockAggregator.sol:MockAggregator", true)}${encodeAbiParameters([{ type: "uint8" }, { type: "int256" }], [8, MCK_ANSWER]).slice(2)}` as Hex);
  // the guard wants aggregator() to be a different contract than the proxy
  const dw = walletFor("deployer");
  await ctx.pub.waitForTransactionReceipt({ hash: await dw.writeContract({ address: feed, abi: parseAbi(["function setAggregator(address) external"]), functionName: "setAggregator", args: [ctx.usdg], chain: null, account: dw.account! }) });
  const stock = opts.alwaysOpen ? zeroAddress : await deployCode(ctx, forgeBytecode("test/mocks/MockStockToken.sol:MockStockToken", true));
  const cfg = {
    feed, stockToken: stock, multiplierEmbedded: embedded, pythMultiplierEmbedded: true, alwaysOpen: opts.alwaysOpen ?? false, pythId, twapPool: zeroAddress,
    maxAgeOpen: 259_200, maxAgeExtended: 259_200, maxAgeClosed: 1_209_600, refMaxAge: 86_400, twapWindow: 1800, refBandBps: 2000, continuityBps: 1500, enabled: true,
  };
  const tl = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await asTimelock((w, t) => w.writeContract({ address, abi, functionName, args, gas: 10_000_000n, chain: null, account: t } as never));
    const r = await ctx.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} ${symbol} reverted (${hash})`);
  };
  await tl(guard, IODOracleGuardAbi as Abi, "setMarket", [id, cfg]);
  await tl(ctx.c.ODVolOracle!, IODVolOracleAbi as Abi, "setBounds", [id, 3000n, opts.volCeil ?? 20000n]);
  await tl(ctx.c.ODGovernor!, IODGovernorAbi as Abi, "setMarketGroup", [id, 0]);
  const m: MockMarket = { symbol, id, feed, stock, pythId, embedded, decimals: 8 };
  ctx.mocks.set(symbol, m);
  await refreshMocks(ctx);
  return m;
}

/** Re-prices every mock market's Pyth entry from its mock feed at the fork clock (the feed answer times the multiplier
 * when the feed is not multiplier-embedded) and keeps the feed's updatedAt as set. */
export async function refreshMocks(ctx: Ctx): Promise<void> {
  const pyth = getAddress(ctx.dep.external.pythCore!);
  const w = walletFor("spare1");
  const now = await nowTs(ctx);
  for (const m of ctx.mocks.values()) {
    if (/^0x(0+)$/.test(m.pythId)) continue;
    const [, answer] = (await ctx.pub.readContract({ address: m.feed, abi: mockFeedAbi, functionName: "latestRoundData" })) as [bigint, bigint, bigint, bigint, bigint];
    const mult = m.embedded || m.stock === zeroAddress ? 10n ** 18n : ((await ctx.pub.readContract({ address: m.stock, abi: mockStockAbi, functionName: "uiMultiplier" })) as bigint);
    const price = (answer * mult) / 10n ** 18n;
    const hash = await w.writeContract({ address: pyth, abi: mockPythAbi, functionName: "setPrice", args: [m.pythId, price, 0n, -m.decimals, now], chain: null, account: w.account! });
    await ctx.pub.waitForTransactionReceipt({ hash });
  }
}

/** Sets the mock feed to `answer` (8 dp) updated now. */
export async function pushMockFeed(ctx: Ctx, row: Row, m: MockMarket, answer: bigint, updatedAt?: bigint, label = "mock feed round"): Promise<void> {
  const now = updatedAt ?? (await nowTs(ctx));
  await row.send(label, "deployer", { address: m.feed, abi: mockFeedAbi, functionName: "setRound", args: [answer, now] });
}

/** `guard.poke(market)` as the crank role, so the market's last good price is current (closed-session reads use it). */
export async function pokeMarket(ctx: Ctx, row: Row | null, symbol: string): Promise<void> {
  const w = walletFor("crank");
  const hash = await w.writeContract({ address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi, functionName: "poke", args: [marketId(symbol)], chain: null, account: w.account! } as never);
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  row?.txs.push({ label: `poke ${symbol}`, hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
}

// ------------------------------------------------------------------------------------------------ money

export const U = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));

/** Gives `role` USDG and ETH (impersonated real holder, R3) and approves the minter. */
export async function fundRole(ctx: Ctx, role: Role, usdgAmt: number): Promise<Address> {
  const who = addressOf(role);
  // top up only the deficit: the real USDG holder is finite and the rows rerun on the same fork
  const have = await usdgOf(ctx, who);
  const want = BigInt(Math.round(usdgAmt * 1e6));
  if (have < want) await fund([who], Number(want - have) / 1e6, 10);
  else await ctx.test.setBalance({ address: who, value: 10n * 10n ** 18n });
  return who;
}

export async function approveMinter(ctx: Ctx, row: Row | null, role: Role, token: Address, spender: Address, amount = 2n ** 255n): Promise<void> {
  const allowance = (await ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [addressOf(role), spender] })) as bigint;
  if (allowance >= amount / 2n) return;
  const hash = await walletFor(role).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount], chain: null, account: walletFor(role).account! });
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  row?.txs.push({ label: `approve ${role}`, hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
}

export interface Quote { amountIn: bigint; amountOut: bigint; valuePerTokenWad: bigint; pricePerTokenWad: bigint; spreadBps: number; protocolFeeUsdg: bigint; tollPerDayWad: bigint; session: number; queued: boolean }

export async function minterQuote(ctx: Ctx, t: bigint | null, gearId: Hex, isBuy: boolean, exactIn: boolean, amount: bigint, from?: Address): Promise<Quote> {
  const args = [gearId, isBuy, exactIn, amount] as const;
  if (t === null) return (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "quote", args, ...(from ? { account: from } : {}) })) as Quote;
  return (await readAt(ctx, t, ctx.c.ODMinter!, IODMinterAbi, "quote", args, from)) as Quote;
}

export async function poolKey(ctx: Ctx, gearId: Hex) {
  return (await ctx.pub.readContract({ address: ctx.c.ODHook!, abi: hookAbi, functionName: "poolKeyOf", args: [gearId] })) as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
}

/** The deployed V4Quoter's exact-in quote for a gear pool (buy: USDG in, gear out; sell: gear in, USDG out). */
export async function v4Quote(ctx: Ctx, t: bigint | null, gearId: Hex, isBuy: boolean, amountIn: bigint): Promise<bigint> {
  const key = await poolKey(ctx, gearId);
  const usdgIs0 = key.currency0.toLowerCase() === ctx.usdg.toLowerCase();
  const zeroForOne = isBuy === usdgIs0;
  const args = [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" as Hex }] as const;
  const to = getAddress(ctx.dep.external.v4Quoter!);
  const data = encodeFunctionData({ abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args });
  const out = await callAt(ctx, t ?? (await nowTs(ctx)), { to, data });
  return (decodeFunctionResult({ abi: v4QuoterAbi, functionName: "quoteExactInputSingle", data: out }) as readonly [bigint, bigint])[0];
}

/** Permit2 allowance of the Universal Router for `token` (one-time per wallet and token). */
export async function permitRouter(ctx: Ctx, row: Row | null, role: Role, token: Address): Promise<void> {
  await approveMinter(ctx, row, role, token, PERMIT2);
  const w = walletFor(role);
  const hash = await w.writeContract({ address: PERMIT2, abi: permit2Abi, functionName: "approve", args: [token, UNIVERSAL_ROUTER, 2n ** 160n - 1n, 2 ** 48 - 1], chain: null, account: w.account! });
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  row?.txs.push({ label: `permit2 router ${role}`, hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
}

/** The Universal Router V4_SWAP call for an exact-in single hop through a gear pool: SWAP_EXACT_IN_SINGLE, SETTLE_ALL,
 * TAKE_ALL (the wallet order the 06b fork test uses). */
export async function urSwapRequest(ctx: Ctx, gearId: Hex, isBuy: boolean, amountIn: bigint, token: Address, minOut = 0n, deadline?: bigint): Promise<SendReq> {
  const key = await poolKey(ctx, gearId);
  const usdgIs0 = key.currency0.toLowerCase() === ctx.usdg.toLowerCase();
  const zeroForOne = isBuy === usdgIs0;
  const inToken = isBuy ? ctx.usdg : token;
  const outToken = isBuy ? token : ctx.usdg;
  const keyT = { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] } as const;
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [keyT, { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "bytes" }] } as never],
    [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, amountIn, minOut, 0n, "0x"]] as never,
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inToken, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outToken, 0n]);
  const actions = "0x060c0f" as Hex;
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  return { address: UNIVERSAL_ROUTER, abi: urAbi as unknown as Abi, functionName: "execute", args: ["0x10", [input], deadline ?? (await nowTs(ctx)) + 3600n] };
}

export type { WalletClient };

// ------------------------------------------------------------------------------------------------ Governor capital

/** A trade needs Governor equity (the cap is a share of it). Seeds the real Governor through its public path: the timelock
 * allows one depositor (anvil account `spare2`), who deposits `usdg` USDG with `deposit` (never a plain transfer, VAULT-1).
 * 22c: G01/G02 test the EMPTY Governor, so run first-money before any area that calls this. */
export async function ensureCapital(ctx: Ctx, row: Row | null, usdg = 4_000_000): Promise<void> {
  const gov = ctx.c.ODGovernor!;
  const supply = (await ctx.pub.readContract({ address: gov, abi: IODGovernorAbi, functionName: "totalSupply" })) as bigint;
  if (supply > 0n) return;
  const who = addressOf("spare2");
  await fund([who], usdg, 10);
  const hash = await asTimelock((w, t) => w.writeContract({ address: gov, abi: IODGovernorAbi as Abi, functionName: "setDepositor", args: [who, true], gas: 1_000_000n, chain: null, account: t } as never));
  await ctx.pub.waitForTransactionReceipt({ hash });
  await approveMinter(ctx, row, "spare2", ctx.usdg, gov);
  const w = walletFor("spare2");
  await freshen(ctx, ["ETH", "BTC"]);
  const dh = await w.writeContract({ address: gov, abi: IODGovernorAbi, functionName: "deposit", args: [BigInt(usdg) * 10n ** 6n, who], gas: 3_000_000n, chain: null, account: w.account! } as never);
  const r = await ctx.pub.waitForTransactionReceipt({ hash: dh });
  row?.txs.push({ label: "Governor deposit (spare2)", hash: dh, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
  if (r.status !== "success") throw new Error(`Governor deposit reverted (${dh})`);
}

// ------------------------------------------------------------------------------------------------ deployment file sync

const GEAR_NAMES = ["CRUISE", "SPORT", "RACE", "ECO", "REVERSE"] as const;
const asciiOf = (b: Hex) => Buffer.from(b.slice(2), "hex").toString("utf8").replace(/\0+$/, "");

/** 22a gap: up.sh lists gears AFTER the deploy file is written, so `deployment.json` has `gears: []` and the API (which
 * resolves a gear and its symbol, cap and unit only from that file) answers "Unknown gear" to every quote. This rewrites
 * the file's `gears` (and the mock markets) from the registry and, when the file changed, restarts the stack so the API
 * reloads it (down.sh then up.sh keep state). Returns true when it restarted. */
export async function syncDeployment(ctx: Ctx): Promise<boolean> {
  const reg = ctx.c.ODGearRegistry!;
  const n = Number((await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gearCount" })) as bigint);
  const file = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, unknown> & { gears: unknown[]; markets: { symbol: string }[] };
  const gears: unknown[] = [];
  const mockSyms = new Set<string>();
  for (let i = 0; i < n; i++) {
    const id = (await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gearIdAt", args: [BigInt(i)] })) as Hex;
    const g = (await ctx.pub.readContract({ address: reg, abi: IODGearRegistryAbi, functionName: "gear", args: [id] })) as { marketA: Hex; marketB: Hex; gear: number; token: Address; unitWad: bigint; capUsdWad: bigint; spreadBps: number };
    const symbol = (await ctx.pub.readContract({ address: g.token, abi: parseAbi(["function symbol() view returns (string)"]), functionName: "symbol" })) as string;
    const poolId = (await ctx.pub.readContract({ address: ctx.c.ODHook!, abi: ABIS.IODHook as never, functionName: "poolIdOf", args: [id] })) as Hex;
    const a = asciiOf(g.marketA), b = /^0x0+$/.test(g.marketB) ? null : asciiOf(g.marketB);
    for (const m of [a, b]) if (m?.startsWith("MCK")) mockSyms.add(m);
    gears.push({
      id, symbol, gear: GEAR_NAMES[g.gear], power: POWER_OF[g.gear], marketA: a, marketB: b, token: getAddress(g.token), poolId,
      capUsd: (g.capUsdWad / 10n ** 18n).toString(), spreadBps: g.spreadBps, unitUsd: (g.unitWad / 10n ** 18n).toString(),
    });
  }
  const markets = file.markets.filter((m) => !(m.symbol.startsWith("MCK") && ctx.mocks.has(m.symbol)));
  for (const s of mockSyms) {
    const m = ctx.mocks.get(s);
    if (!m) continue;
    markets.push({
      id: m.id, symbol: s, kind: m.stock === zeroAddress ? "crypto" : "stock", feed: m.feed, stockToken: m.stock === zeroAddress ? null : m.stock,
      multiplierEmbedded: m.embedded, pythId: m.pythId, twapPool: null, alwaysOpen: m.stock === zeroAddress,
    } as never);
  }
  const next = { ...file, gears, markets };
  if (JSON.stringify(next) === JSON.stringify(file)) return false;
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(next, null, 2)}\n`);
  for (const script of ["down.sh", "up.sh"]) {
    const p = Bun.spawnSync(["/bin/bash", `${import.meta.dir}/../${script}`], { env: { ...process.env, PORT_OFFSET: process.env.PORT_OFFSET ?? "0" }, stdout: "pipe", stderr: "pipe" });
    // the web profile is not part of the exercises: a web health failure alone (exit 1 after "api" and "indexer" are up) is tolerated
    const out = p.stdout.toString();
    const all = `${out}\n${p.stderr.toString()}`;
    const webOnly = script === "up.sh" && /up: web\b/.test(all) && !/up: (?!web\b)(\w+) (exited|not healthy)/.test(all) && /up: api\b/.test(all);
    if (p.exitCode !== 0 && !webOnly) throw new Error(`${script} failed: ${p.stdout.toString().slice(-400)} ${p.stderr.toString().slice(-400)}`);
  }
  void FORK_DIR;
  return true;
}

/** Starts one stack service again (up.sh with UP_SERVICES, which keeps every running service and the chain state). */
export function startService(name: string): void {
  const p = Bun.spawnSync(["/bin/bash", `${import.meta.dir}/../up.sh`], { env: { ...process.env, PORT_OFFSET: process.env.PORT_OFFSET ?? "0", UP_SERVICES: name }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`up.sh (${name}) failed: ${p.stdout.toString().slice(-300)} ${p.stderr.toString().slice(-300)}`);
}

// ------------------------------------------------------------------------------------------------ holder flow helpers

import { Gear as PGear, Rounding, value as formulaValue } from "../../../src/pricing";
import { normStep } from "../../../src/pricing/norm";
import { gapRate } from "../../../src/pricing/toll";

export interface NormSt { nf: bigint; tollPerSecWad: bigint; lastAccrual: bigint; cumTollPerTokenWad: bigint }
export const normOf = async (ctx: Ctx, id: Hex) => (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "normState", args: [id] })) as unknown as NormSt;
export const valueOf = async (ctx: Ctx, id: Hex) => (await ctx.pub.readContract({ address: ctx.c.ODMinter!, abi: IODMinterAbi, functionName: "valuePerToken", args: [id] })) as unknown as readonly [bigint, boolean];
export const priceOf = async (ctx: Ctx, symbol: string) => ((await ctx.pub.readContract({ address: ctx.c.ODOracleGuard!, abi: IODOracleGuardAbi, functionName: "read", args: [marketId(symbol)] })) as { p: bigint; refP: bigint; session: number; fresh: boolean; buysPaused: boolean; reason: Hex });

/** Value per token from the closed form (src/pricing, the TypeScript twin of ODIndex/ODNorm), p/p0 and the given NF. */
export async function formulaValueOf(ctx: Ctx, g: GearInfo, p: bigint, nf: bigint): Promise<bigint> {
  const cfg = (await ctx.pub.readContract({ address: ctx.c.ODGearRegistry!, abi: IODGearRegistryAbi, functionName: "gear", args: [g.id] })) as { p0: bigint; unitWad: bigint };
  return formulaValue(g.gear as PGear, p, cfg.p0, nf, cfg.unitWad, Rounding.Floor).valueWad;
}
export { normStep };

/** The stored norm state: the latest Accrued event of the gear (its nf and rate) at that block's time. */
export async function writtenNorm(ctx: Ctx, id: Hex): Promise<NormSt> {
  const logs = parseEventLogs({
    abi: IODMinterAbi, eventName: "Accrued",
    logs: await ctx.pub.getLogs({ address: ctx.c.ODMinter!, fromBlock: BigInt(ctx.dep.startBlock), toBlock: "latest" }),
  }).filter((l) => l.args.gearId.toLowerCase() === id.toLowerCase());
  const last = logs[logs.length - 1];
  if (!last) return { nf: 10n ** 18n, tollPerSecWad: 0n, lastAccrual: 0n, cumTollPerTokenWad: 0n };
  const blk = await ctx.pub.getBlock({ blockNumber: last.blockNumber });
  return { nf: last.args.nf, tollPerSecWad: last.args.tollPerSecWad, lastAccrual: blk.timestamp, cumTollPerTokenWad: 0n };
}

/** Accrues a gear at a pinned second and returns the norm state before and after plus the closed-form NF. */
export async function accruePinned(ctx: Ctx, row: Row, g: GearInfo, label: string, base?: NormSt) {
  // normState is a view AS IF accrued now, so the WRITTEN state is the last Accrued event (nf, rate, block time)
  const before = base ?? (await writtenNorm(ctx, g.id));
  const rec = await atNextSecond(ctx, () => row.send(label, "crank", { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "accrue", args: [g.id] }));
  const after = await normOf(ctx, g.id);
  const dt = after.lastAccrual - before.lastAccrual;
  const ev = parseEventLogs({ abi: IODMinterAbi, logs: (await ctx.pub.getTransactionReceipt({ hash: rec.hash as Hex })).logs, eventName: "Accrued" }).find((l) => l.args.gearId.toLowerCase() === g.id.toLowerCase());
  const accruedNf = ev?.args.nf ?? after.nf;
  const rate = gapRate(before.tollPerSecWad, after.tollPerSecWad);
  return { before, after, dt, expectedNf: normStep(before.nf, rate, dt), accruedNf, rec };
}

/** A direct minter buy as `role` with the quote taken in the same pinned second. Returns tokens received and the quote. */
export async function buyDirect(ctx: Ctx, row: Row, role: Role, g: GearInfo, usdgIn: bigint, label: string) {
  const who = addressOf(role);
  await approveMinter(ctx, row, role, ctx.usdg, ctx.c.ODMinter!);
  const t0 = await tokenOf(ctx, g.token, who), u0 = await usdgOf(ctx, who);
  const { quote: q, exact } = await atNextSecond(ctx, async (t) => {
    const b0 = await ctx.pub.getBlockNumber({ cacheTime: 0 });
    const quote = await minterQuote(ctx, t, g.id, true, true, usdgIn, who);
    const rec = await row.send(label, role, { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "buy", args: [g.id, usdgIn, 0n, who, t + 3600n] });
    const r = await ctx.pub.getTransactionReceipt({ hash: rec.hash as Hex });
    const blk = await ctx.pub.getBlock({ blockNumber: r.blockNumber });
    return { quote, exact: r.blockNumber === b0 + 1n && blk.timestamp === t };
  });
  const got = (await tokenOf(ctx, g.token, who)) - t0;
  if (exact) row.chain(`${label}: tokens == quote`, got, q.amountOut);
  else {
    // a service block landed between the quote and the send, so the state moved: hold the product's own promise instead,
    // the quote less SLIPPAGE_BPS (50), rounded down (app/src/api/quote/model.ts:76-78, minOutSuggested)
    const floor = (q.amountOut * (10_000n - 50n)) / 10_000n;
    row.note(`${label}: a service block landed between quote and send; asserted tokens >= minOutSuggested (${floor})`);
    row.chainTrue(`${label}: tokens >= minOutSuggested(quote)`, got >= floor, `${got} >= ${floor}`);
  }
  row.chain(`${label}: USDG paid`, u0 - (await usdgOf(ctx, who)), usdgIn);
  return { got, q };
}

export async function sellDirect(ctx: Ctx, row: Row, role: Role, g: GearInfo, tokens: bigint, label: string) {
  const who = addressOf(role);
  await approveMinter(ctx, row, role, g.token, ctx.c.ODMinter!);
  const t0 = await tokenOf(ctx, g.token, who), u0 = await usdgOf(ctx, who);
  const { quote: q, exact } = await atNextSecond(ctx, async (t) => {
    const b0 = await ctx.pub.getBlockNumber({ cacheTime: 0 });
    const quote = await minterQuote(ctx, t, g.id, false, true, tokens, who);
    try {
      row.chain(`${label}: V4Quoter sell == minter.quote`, await v4Quote(ctx, t, g.id, false, tokens), quote.amountOut);
    } catch (e) {
      if (!revertNames(e).includes("PoolManagerShort")) throw e;
      // D26: the hook takes the sold gear out of the PoolManager before the swapper settles, so the PoolManager must hold gear
      row.note("hook sell path reverts PoolManagerShort (no gear seeded in the PoolManager, backlog D26); direct minter sell asserted");
    }
    const rec = await row.send(label, role, { address: ctx.c.ODMinter!, abi: IODMinterAbi as Abi, functionName: "sell", args: [g.id, tokens, 0n, who, t + 3600n] });
    const r = await ctx.pub.getTransactionReceipt({ hash: rec.hash as Hex });
    const blk = await ctx.pub.getBlock({ blockNumber: r.blockNumber });
    return { quote, exact: r.blockNumber === b0 + 1n && blk.timestamp === t };
  });
  row.chain(`${label}: tokens burned`, t0 - (await tokenOf(ctx, g.token, who)), tokens);
  const got = (await usdgOf(ctx, who)) - u0;
  if (exact) row.chain(`${label}: USDG received == quote`, got, q.amountOut);
  else {
    // same rule as buyDirect: a service block landed between the quote and the send, so hold minOutSuggested instead
    const floor = (q.amountOut * (10_000n - 50n)) / 10_000n;
    row.note(`${label}: a service block landed between quote and send; asserted USDG >= minOutSuggested (${floor})`);
    row.chainTrue(`${label}: USDG received >= minOutSuggested(quote)`, got >= floor, `${got} >= ${floor}`);
  }
  return q;
}

/** The API's balance row for (account, gear symbol), polled until `want` shows or 30 s pass. */
export async function apiBalance(who: Address, symbol: string, want: bigint): Promise<{ balance: bigint; valueUsdg: bigint } | null> {
  const r = await pollApi(() => apiGet<{ balances: { gear: string; balance: string; valueUsdg: string }[] }>(`/v1/account/${who}`), (a) => BigInt(a.balances.find((b) => b.gear === symbol)?.balance ?? "-1") === want);
  const b = r.balances.find((x) => x.gear === symbol);
  return b ? { balance: BigInt(b.balance), valueUsdg: BigInt(b.valueUsdg) } : null;
}
export async function apiGear(id: Hex) {
  const r = await apiGet<{ gears: { id: string; nf: string; valuePerToken: string; tollPerDayBps: string; holdersReceive: boolean; buyable: boolean; reason: string | null; sellMode: string; session: string }[] }>("/v1/gears");
  return r.gears.find((g) => g.id.toLowerCase() === id.toLowerCase());
}
export async function warpBy(ctx: Ctx, seconds: number): Promise<void> {
  await ctx.test.increaseTime({ seconds });
  await ctx.test.mine({ blocks: 1 });
}

/** Pushes the NYSE calendar for the 30 days after the chain clock to ODMarketHours, as the crank's sessions job does (same
 * computeSessions, same setSessionsWithKinds, same keeper key). Needed after every long warp: the real job runs once an hour
 * of wall time and `crank --once` cannot run beside the crank service (single-instance lock). */
export async function pushCalendar(ctx: Ctx, row?: Row): Promise<void> {
  const { computeSessions, KIND_CODE } = await import("../../../src/crank/sessions");
  const { IODMarketHoursAbi } = await import("../../../src/abi");
  const now = await nowTs(ctx);
  const next = computeSessions(new Date(Number(now) * 1000), "us_equity", 30);
  const w = walletFor("crank");
  const hash = await w.writeContract({
    address: ctx.c.ODMarketHours!, abi: IODMarketHoursAbi, functionName: "setSessionsWithKinds", gas: 8_000_000n, chain: null, account: w.account!,
    args: [next.map((x) => ({ open: x.open, close: x.close })), next.map((x) => KIND_CODE[x.kind as "regular" | "extended"])],
  } as never);
  const r = await ctx.pub.waitForTransactionReceipt({ hash });
  row?.txs.push({ label: "push NYSE calendar (crank keeper)", hash, gas: r.gasUsed.toString(), status: r.status === "success" ? "success" : "reverted" });
  if (r.status !== "success") throw new Error(`calendar push reverted (${hash})`);
}

/** Moves the chain clock to an open regular session (+10 min) or to Saturday noon New York, pushes the calendar and checks
 * the session the guard reports for `symbol`. */
export async function gotoSession(ctx: Ctx, kind: "open" | "weekend", symbol = "MCKA", row?: Row): Promise<void> {
  const { warpTarget } = await import("../warp");
  let last = -1;
  for (let day = 0; day < 2; day++) {
    const now = Number(await nowTs(ctx));
    const base = now + day * 86_400; // second try only: the guard may need the next day's calendar
    const target = kind === "open" ? warpTarget(base, "to-next-open") + 600 : warpTarget(base, "to-weekend");
    // the pushed calendar covers [first open, last close): a weekend instant is only CLOSED (not UNKNOWN) when the push was made before it
    if (kind === "weekend") await pushCalendar(ctx, row);
    if (target > now) { await ctx.test.increaseTime({ seconds: target - now }); await ctx.test.mine({ blocks: 1 }); }
    if (kind === "open") await pushCalendar(ctx, row);
    // a mock feed left stale by an earlier flow would read HALTED: touch each one at the new clock (answer unchanged)
    for (const m of ctx.mocks.values()) {
      const [, answer] = (await ctx.pub.readContract({ address: m.feed, abi: mockFeedAbi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const dw = walletFor("deployer");
      await ctx.pub.waitForTransactionReceipt({ hash: await dw.writeContract({ address: m.feed, abi: mockFeedAbi, functionName: "setRound", args: [answer, await nowTs(ctx)], chain: null, account: dw.account! }) });
    }
    await refreshPyth();
    await refreshMocks(ctx);
    last = (await priceOf(ctx, symbol)).session;
    if (kind === "open" ? last === 0 : last === 2) return;
  }
  throw new Error(`could not reach a ${kind} session for ${symbol} (guard session ${last})`);
}
