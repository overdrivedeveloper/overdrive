// An in-memory stand-in for the contracts the crank touches (minter, market hours, oracle guard, stock tokens, vol oracle,
// backer, governor, fees), built to the REAL IOD* ABIs: reads answer from state, writes are decoded from calldata and
// applied. It enforces the contract limits (session calendar, atomic accrueMany) so a crank bug shows up as a revert.
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";
import pino from "pino";
import type { Sql } from "postgres";
import {
  IODBackerAbi, IODFeesAbi, IODGearAbi, IODGearRegistryAbi, IODGovernorAbi, IODMarketHoursAbi, IODMinterAbi, IODOracleGuardAbi, IODVolOracleAbi,
} from "../abi";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import { RevertError } from "../chain/revert";
import { loadConfig, type RuntimeConfig } from "../config";
import type { CrankContext } from "../crank/context";
import { PythAbi } from "../crank/jobs/pyth-push";
import type { CrankTransaction, TxQueue, TxResult } from "../crank/tx";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const logger = pino({ level: "silent" });
export const WAD = 10n ** 18n;
export const stockAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)",
]);
export const hasRoleAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);

export const marketId = (symbol: string): Hex => keccak256(toHex(symbol));
export const MARKET_TSLA = marketId("TSLA");
export const MARKET_NVDA = marketId("NVDA");
export const MARKET_ETH = marketId("ETH");
const addr = (label: string): Address => getAddress(`0x${keccak256(toHex(label)).slice(26)}`);
export const STOCK_TSLA = addr("stock-tsla");
export const STOCK_NVDA = addr("stock-nvda");
export const CRANK_ADDRESS = addr("crank-account");
export const ZERO_ID = `0x${"0".repeat(64)}` as Hex;

export function mockDeployment(): Deployment {
  const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "deployment.fork.json"), "utf8")) as Deployment;
  const market = (id: Hex, symbol: string, kind: "stock" | "crypto", stockToken: Address | null) =>
    ({ id, symbol, kind, feed: addr(`feed-${symbol}`), stockToken, multiplierEmbedded: false, pythId: null, twapPool: null, alwaysOpen: kind === "crypto" });
  return { ...base, markets: [market(MARKET_TSLA, "TSLA", "stock", STOCK_TSLA), market(MARKET_NVDA, "NVDA", "stock", STOCK_NVDA), market(MARKET_ETH, "ETH", "crypto", null)], gears: [] };
}

export interface FakeGear {
  id: Hex; marketA: Hex; marketB: Hex; token: Address; status: number; nf: bigint; lastAccrual: bigint; supply: bigint;
  /** Toll per second, WAD (positive = holders pay). */
  tollPerSecWad: bigint;
  /** accrueMany containing this gear reverts with this contract error name (a malformed row, a paused feed). */
  revertName?: string;
}
export interface FakePrice { p: bigint; refP: bigint; session: number; fresh: boolean; buysPaused: boolean; reason: Hex; updatedAt: bigint }
export interface FakeVol { sigmaBps: bigint; postedAt: bigint; validUntil: bigint; stale: boolean; hardStale: boolean }
export interface SentTx { value?: bigint; label: string; to: Address; data: Hex; contract: string; name: string; args: readonly unknown[]; simulated: boolean }

const CONTRACT_ABIS: Record<string, Abi> = {
  ODMinter: IODMinterAbi as Abi, ODMarketHours: IODMarketHoursAbi as Abi, ODOracleGuard: IODOracleGuardAbi as Abi, ODGovernor: IODGovernorAbi as Abi,
  Pyth: PythAbi as Abi, ODFees: IODFeesAbi as Abi, ODBacker: IODBackerAbi as Abi, ODVolOracle: IODVolOracleAbi as Abi, ODGearRegistry: IODGearRegistryAbi as Abi,
};

const reasonHex = (text: string): Hex => toHex(text, { size: 32 });
export const REASON = { none: ZERO_ID, SPLIT_PENDING: reasonHex("SPLIT_PENDING"), CONTINUITY: reasonHex("CONTINUITY"), HALTED: reasonHex("HALTED") };

export class FakeChain {
  deployment = mockDeployment();
  nowSeconds = 1_800_000_000n;
  gears = new Map<Hex, FakeGear>();
  order: Hex[] = [];
  prices = new Map<Hex, FakePrice>();
  stock = new Map<Address, { ui: bigint; pending: bigint; effectiveAt: bigint }>();
  vol = new Map<Hex, FakeVol>();
  uplift = new Map<Hex, boolean>();
  sessions: { open: bigint; close: bigint }[] = [];
  kinds: number[] = [];
  kind = 2;
  roles = new Set<string>();
  balances = new Map<Address, bigint>();
  sent: SentTx[] = [];
  /** Function names (or `${name}:${first arg}`) whose next calls revert with "execution reverted: Failing()". */
  failing = new Set<string>();
  /** accrueMany gas model: used = 60000 + gasPerGear * count; a batch above gasLimit fails out of gas. */
  gasPerGear = 90_000n;
  gasLimit = 30_000_000n;
  blockGasLimit = 60_000_000n;
  dryRun = false;
  /** Logs the next confirmed transaction reports in its receipt (a mutator pushes them). */
  pendingLogs: { address: Address; topics: readonly Hex[]; data: Hex }[] = [];
  reads = 0;
  chainId = 31337;
  /** Hook for 14b state (fees, queue, governor); keyed by `${contract}.${function}`. */
  readers = new Map<string, (args: readonly unknown[]) => unknown>();
  mutators = new Map<string, (args: readonly unknown[], commit: boolean) => bigint | void>();

  addGear(partial: Partial<FakeGear> & { id: Hex; marketA: Hex }): FakeGear {
    const gear: FakeGear = { marketB: ZERO_ID, token: addr(`token-${partial.id}`), status: 1, nf: WAD, lastAccrual: this.nowSeconds, supply: 1000n * WAD, tollPerSecWad: 0n, ...partial };
    this.gears.set(gear.id, gear);
    this.order.push(gear.id);
    return gear;
  }
  addMarketPrice(market: Hex, partial: Partial<FakePrice> = {}): FakePrice {
    const price = { p: 100n * WAD, refP: 100n * WAD, session: 0, fresh: true, buysPaused: false, reason: REASON.none, updatedAt: this.nowSeconds, ...partial };
    this.prices.set(market, price);
    return price;
  }
  /** Healthy Governor and Fees reads, for tests that only need the jobs that read them to run clean. */
  healthyGovernor(): void {
    const r = this.readers;
    r.set("ODGovernor.decimals", () => 12);
    r.set("ODGovernor.convertToAssets", () => 10n ** 12n);
    r.set("ODGovernor.exitReserve", () => 500_000_000n);
    r.set("ODGovernor.exitReserveFloor", () => 100_000_000n);
    r.set("ODGovernor.stressLoss", () => [0n, 100n * WAD]);
    r.set("ODGovernor.hedgeStale", () => false);
    r.set("ODGovernor.buysPaused", () => [false, ZERO_ID]);
    r.set("ODFees.nextDistributionAt", () => this.nowSeconds + 86_400n);
    r.set("ODFees.distributable", () => 0n);
  }
  warp(seconds: number | bigint): void { this.nowSeconds += BigInt(seconds); }
  wallClock(): Date { return new Date(Number(this.nowSeconds) * 1000); }

  private contractOf(address: string): string | undefined {
    for (const [name, a] of Object.entries(this.deployment.contracts)) if (a && a.toLowerCase() === address.toLowerCase()) return name;
    if (this.deployment.external.pythCore.toLowerCase() === address.toLowerCase()) return "Pyth";
    if ([...this.gears.values()].some((g) => g.token.toLowerCase() === address.toLowerCase())) return "gear";
    if (this.deployment.markets.some((m) => m.stockToken?.toLowerCase() === address.toLowerCase())) return "stock";
    return undefined;
  }
  private gearByToken(address: string): FakeGear | undefined { return [...this.gears.values()].find((g) => g.token.toLowerCase() === address.toLowerCase()); }

  // ----------------------------------------------------------------------------------------------------------- reads
  read(address: Address, functionName: string, args: readonly unknown[] = []): unknown {
    this.reads++;
    const contract = this.contractOf(address);
    const hook = this.readers.get(`${contract}.${functionName}`);
    if (hook) return hook(args);
    const id = args[0] as Hex;
    switch (`${contract}.${functionName}`) {
      case "ODGearRegistry.gearCount": return BigInt(this.order.length);
      case "ODGearRegistry.gearIdAt": return this.order[Number(args[0])]!;
      case "ODGearRegistry.gear": { const g = this.gears.get(id)!; return { marketA: g.marketA, marketB: g.marketB, gear: 0, token: g.token, p0: WAD, unitWad: WAD, capUsdWad: WAD, spreadBps: 30, collateralBps: 20000, maintenanceBps: 15000, status: g.status, listedAt: 1n }; }
      case "ODMinter.normState": { const g = this.gears.get(id)!; return { nf: g.nf, tollPerSecWad: g.tollPerSecWad, lastAccrual: g.lastAccrual, cumTollPerTokenWad: 0n }; }
      case "gear.totalSupply": return this.gearByToken(address)!.supply;
      case "ODMarketHours.kindAt": return this.kind;
      case "ODMarketHours.sessions": return this.sessions.map((s) => ({ ...s }));
      case "ODMarketHours.sessionKinds": return [...this.kinds];
      case "ODOracleGuard.read": { const p = this.prices.get(id); if (!p) throw new RevertError({ name: "MarketUnknown", args: [id], signature: "0x" }, undefined); return { ...p }; }
      case "stock.uiMultiplier": return this.stockOf(address).ui;
      case "stock.newUIMultiplier": return this.stockOf(address).pending;
      case "stock.effectiveAt": return this.stockOf(address).effectiveAt;
      case "ODVolOracle.read": {
        const v = this.vol.get(id);
        if (!v) return { sigmaBps: 4500n, postedAt: this.nowSeconds, validUntil: this.nowSeconds + 7200n, buyBlockFrom: 0n, buyBlockTo: 0n, stale: false, hardStale: false };
        return { ...v, buyBlockFrom: 0n, buyBlockTo: 0n };
      }
      case "ODMinter.valuePerToken": return [WAD, true];
      case "ODBacker.upliftActive": return [this.uplift.get(id) ?? false, 0];
    }
    if (functionName === "hasRole") return this.roles.has(`${address.toLowerCase()}:${String(args[0])}:${String(args[1]).toLowerCase()}`) || this.roles.has("*");
    throw new Error(`mock chain: no reader for ${contract}.${functionName}`);
  }
  private stockOf(address: Address) { const s = this.stock.get(address) ?? { ui: WAD, pending: 0n, effectiveAt: 0n }; this.stock.set(address, s); return s; }

  // ---------------------------------------------------------------------------------------------------------- writes
  /** Decodes calldata against the real ABI, validates (throws a RevertError like the contract), and applies when `commit`. */
  execute(to: Address, data: Hex, commit: boolean, label = "tx"): { gasUsed: bigint; contract: string; name: string; args: readonly unknown[] } {
    const contract = this.contractOf(to);
    const abi = contract ? CONTRACT_ABIS[contract] : undefined;
    if (!contract || !abi) throw new Error(`mock chain: unknown target ${to}`);
    const { functionName: name, args = [] } = decodeFunctionData({ abi, data });
    const revert = (errorName: string, errorArgs: unknown[] = []): never => { throw new RevertError({ name: errorName, args: errorArgs, signature: "0x" }, undefined); };
    if (this.failing.has(name) || (args[0] !== undefined && this.failing.has(`${name}:${String(args[0])}`))) revert("Failing");
    let gasUsed = 100_000n;
    const hook = this.mutators.get(`${contract}.${name}`);
    if (hook) { gasUsed = hook(args, commit) ?? gasUsed; return { gasUsed, contract, name, args }; }
    if (contract === "ODMinter" && (name === "accrueMany" || name === "accrue")) {
      const ids = (name === "accrue" ? [args[0]] : args[0]) as Hex[];
      gasUsed = 60_000n + this.gasPerGear * BigInt(ids.length);
      if (gasUsed > this.gasLimit) throw new Error("execution reverted: out of gas");
      for (const id of ids) { const g = this.gears.get(id); if (!g) revert("UnknownGear", [id]); else if (g.revertName) revert(g.revertName, [id]); }
      if (commit) for (const id of ids) {
        const g = this.gears.get(id)!;
        const dt = this.nowSeconds - g.lastAccrual;
        if (dt > 0n) { g.nf = (g.nf * (WAD - g.tollPerSecWad * dt)) / WAD; g.lastAccrual = this.nowSeconds; }
      }
    } else if (contract === "ODMarketHours" && name === "setSessionsWithKinds") {
      const windows = args[0] as { open: bigint; close: bigint }[];
      const kinds = args[1] as number[];
      if (windows.length > 64) revert("TooManySessions", [BigInt(windows.length)]);
      if (kinds.length !== windows.length) revert("SessionKindsLength", [BigInt(windows.length), BigInt(kinds.length)]);
      windows.forEach((w, i) => {
        if (w.close <= w.open) revert("InvalidSession", [BigInt(i)]);
        if (w.close - w.open >= 7n * 86_400n) revert("SessionTooLong", [BigInt(i)]);
        if (w.close > this.nowSeconds + 30n * 86_400n) revert("SessionTooFar", [BigInt(i)]);
        if (kinds[i]! > 1) revert("InvalidSessionKind", [BigInt(i)]);
        if (i > 0 && w.open < windows[i - 1]!.open) revert("SessionsUnsorted", [BigInt(i)]);
        if (i > 0 && w.open < windows[i - 1]!.close) revert("SessionsOverlap", [BigInt(i)]);
      });
      if (commit) { this.sessions = windows.map((w) => ({ ...w })); this.kinds = kinds.map(Number); }
    } else if (contract === "ODOracleGuard" && name === "poke") {
      if (!this.prices.has(args[0] as Hex)) revert("MarketUnknown", [args[0]]);
      if (commit) { const p = this.prices.get(args[0] as Hex)!; if (p.fresh) p.updatedAt = this.nowSeconds; }
    } else if (!(contract === "ODGovernor" && name === "pokeRisk")) {
      throw new Error(`mock chain: no write handler for ${contract}.${name}`);
    }
    return { gasUsed, contract, name, args };
  }

  // ------------------------------------------------------------------------------------------------ client surfaces
  stateClient() {
    const self = this;
    const readOne = (call: { address: Address; functionName: string; args?: readonly unknown[] }) => self.read(call.address, call.functionName, call.args ?? []);
    return {
      readContract: async (call: { address: Address; functionName: string; args?: readonly unknown[] }) => readOne(call),
      multicall: async (params: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; allowFailure?: boolean }) =>
        params.contracts.map((call) => {
          try { const result = readOne(call); return params.allowFailure === false ? result : { status: "success", result }; }
          catch (error) { if (params.allowFailure === false) throw error; return { status: "failure", error }; }
        }),
      getBlock: async () => ({ number: 1n, timestamp: self.nowSeconds, gasLimit: self.blockGasLimit, baseFeePerGas: 1_000_000n, hash: "0x01" }),
      getBalance: async ({ address }: { address: Address }) => self.balances.get(address) ?? 10n * WAD,
      getChainId: async () => self.chainId,
      getCode: async () => "0x",
      request: async () => "anvil/mock",
    };
  }
  /** Estimates through the real queue: validated like a send, recorded as simulated, never applied. `blockOverride.time` is kept. */
  simulate(to: Address, data: Hex, blockOverride?: { time?: Hex }): bigint {
    const { gasUsed, contract, name, args } = this.execute(to, data, false);
    this.sent.push({ label: "estimate", to, data, contract, name, args, simulated: true });
    if (blockOverride?.time) this.estimateTimes.push(BigInt(blockOverride.time));
    return gasUsed;
  }
  estimateTimes: bigint[] = [];
  /** A tx client for the REAL TxQueue: estimateGas validates through `execute` (no broadcast ever happens). */
  txClient() {
    const self = this;
    return {
      ...self.stateClient(),
      estimateGas: async (call: { to: Address; data: Hex }) => self.simulate(call.to, call.data),
      request: async (args: { method: string; params?: unknown[] }) => {
        if (args.method === "eth_estimateGas") {
          const call = args.params![0] as { to: Address; data: Hex };
          return toHex(self.simulate(call.to, call.data, args.params![3] as { time?: Hex } | undefined));
        }
        return "anvil/mock";
      },
      getGasPrice: async () => 1_000_000n,
      getTransactionCount: async () => 0,
      sendRawTransaction: async () => { throw new Error("mock chain never broadcasts"); },
      getTransactionReceipt: async () => { throw new Error("not found"); },
    };
  }
  clients(account?: unknown): ServiceClients {
    const state = this.stateClient();
    return { logsClient: state, stateClient: state, txClient: this.txClient(), walletClient: account ? { account } : undefined, pool: { stats: () => ({}), startHourlyReporter: () => undefined, request: async () => "anvil/mock" }, chainId: this.chainId } as unknown as ServiceClients;
  }

  /** A transaction queue that applies calls to the fake chain; the gas limit of a batch is the policy over its estimate. */
  txQueue(): TxQueue & { sent: SentTx[] } {
    const self = this;
    return {
      sent: self.sent,
      async submit(t: CrankTransaction): Promise<TxResult> {
        const { gasUsed, contract, name, args } = self.execute(t.to, t.data, !self.dryRun, t.label);
        self.sent.push({ label: t.label, to: t.to, data: t.data, contract, name, args, simulated: self.dryRun, ...(t.value !== undefined ? { value: t.value } : {}) });
        return self.dryRun ? { simulated: true, gasUsed } : { simulated: false, gasUsed, hash: keccak256(toHex(self.sent.length)), receipt: { logs: self.pendingLogs.splice(0), blockNumber: 1n } as never };
      },
      status: () => ({ heldNonce: null, heldSince: null, heldHashes: 0 }),
      async drain() {},
    };
  }

  context(sql: Sql, overrides: Record<string, string> = {}): CrankContext & { chain: FakeChain } {
    const config: RuntimeConfig = loadConfig({ NODE_ENV: "test", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: "postgres://localhost/unused", DEPLOYMENT_FILE: "x", ...overrides });
    const self = this;
    return {
      chain: this, sql, clients: this.clients(), deployment: this.deployment, config, logger, tx: this.txQueue(),
      metadata: async () => ({}),
      now: () => self.wallClock(),
    } as CrankContext & { chain: FakeChain };
  }
}



/** A stand-in for the database in job tests that do not need one: every query answers no rows. */
export const nullSql = (async () => []) as unknown as Sql;
