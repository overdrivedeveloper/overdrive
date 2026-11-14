// Fake chain, log builders, scenario generator and table dump shared by the indexer tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Sql } from "postgres";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { IODBackerAbi, IODFeesAbi, IODGearAbi, IODGearRegistryAbi, IODMinterAbi, IODVolOracleAbi } from "../abi";
import type { Deployment } from "../chain/deployment";
import { createIndexerState, createIngest, type IndexerSettings, type IndexerState } from "./ingest";
import type { SnapshotReader } from "./snapshot";
import type { BlockHeader, ChainSource, LogRange, RpcLog } from "./types";

export const logger = pino({ level: "silent" });
const FIXTURE = join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json");

export const MARKET_TSLA = keccak256(toHex("TSLA"));
export const MARKET_NVDA = keccak256(toHex("NVDA"));
export const GEAR_1 = keccak256(toHex("TSLA-CRUISE"));
export const GEAR_2 = keccak256(toHex("TSLA-SPORT"));
const tokenOf = (label: string): Address => getAddress(`0x${keccak256(toHex(`token-${label}`)).slice(26)}`);
export const TOKEN_1 = tokenOf("1");
export const TOKEN_2 = tokenOf("2");
export const STOCK_TSLA = tokenOf("stock-tsla");
export const USERS = [1, 2, 3, 4].map((n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`));
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export function testDeployment(): Deployment {
  const base = JSON.parse(readFileSync(FIXTURE, "utf8")) as Deployment;
  return {
    ...base,
    startBlock: 1,
    markets: [
      { id: MARKET_TSLA, symbol: "TSLA", kind: "stock", feed: USERS[0]!, stockToken: STOCK_TSLA, multiplierEmbedded: false, pythId: null, twapPool: null, alwaysOpen: false },
      { id: MARKET_NVDA, symbol: "NVDA", kind: "stock", feed: USERS[1]!, stockToken: null, multiplierEmbedded: false, pythId: null, twapPool: null, alwaysOpen: false },
    ],
    gears: [],
  };
}

export const addressOf = (deployment: Deployment, name: string): Address => deployment.contracts[name] as Address;

export interface FakeBlock { number: bigint; hash: string; parentHash: string; timestamp: Date; logs: RpcLog[] }

/** An in-memory chain. `fork` replaces everything above an ancestor, which is how reorgs are simulated. */
export class FakeChain implements ChainSource {
  blocks: FakeBlock[] = [];
  salt = 0;
  failLogs: ((range: LogRange) => Error | undefined) | undefined;
  logCalls: LogRange[] = [];
  constructor() { this.blocks.push(this.make(0n, "0x" + "00".repeat(32), [])); }
  private make(number: bigint, parentHash: string, logs: RpcLog[]): FakeBlock {
    return { number, parentHash, hash: keccak256(toHex(`${number}:${parentHash}:${this.salt}:${logs.map((l) => l.data + l.topics.join()).join()}`)), timestamp: new Date(1_700_000_000_000 + Number(number) * 12_000), logs };
  }
  get head(): bigint { return this.blocks[this.blocks.length - 1]!.number; }
  add(logs: Omit<RpcLog, "blockNumber" | "transactionHash" | "logIndex">[]): void {
    const parent = this.blocks[this.blocks.length - 1]!;
    const number = parent.number + 1n;
    this.salt += 1;
    // the tx hash depends on the log's own content, so the same log in the same place hashes the same on every branch
    const full = logs.map((log, index) => ({ ...log, blockNumber: number, logIndex: index, transactionHash: keccak256(toHex(`tx:${number}:${index}:${log.address}:${log.data}:${log.topics.join(",")}`)) }) as RpcLog);
    this.blocks.push(this.make(number, parent.hash, full));
  }
  /** Drops every block above `ancestor` and adds new ones (a different branch). */
  fork(ancestor: bigint, branches: Omit<RpcLog, "blockNumber" | "transactionHash" | "logIndex">[][]): void {
    this.blocks = this.blocks.filter((block) => block.number <= ancestor);
    this.salt += 1000;
    for (const logs of branches) this.add(logs);
  }
  async getHead(): Promise<bigint> { return this.head; }
  async getLogs(range: LogRange) {
    this.logCalls.push(range);
    const error = this.failLogs?.(range);
    if (error) throw error;
    const own = new Set(range.addresses.map((a) => a.toLowerCase()));
    const stock = new Set(range.stockAddresses.map((a) => a.toLowerCase()));
    const logs: RpcLog[] = [];
    const stockLogs: RpcLog[] = [];
    for (const block of this.blocks) {
      if (block.number < range.fromBlock || block.number > range.toBlock) continue;
      for (const log of block.logs) {
        if (own.has(log.address.toLowerCase())) logs.push(log);
        else if (stock.has(log.address.toLowerCase())) stockLogs.push(log);
      }
    }
    return { logs, stockLogs };
  }
  async getHeaders(numbers: readonly bigint[]): Promise<ReadonlyMap<bigint, BlockHeader | undefined>> {
    const out = new Map<bigint, BlockHeader | undefined>();
    for (const n of numbers) {
      const block = this.blocks[Number(n)];
      out.set(n, block && block.number === n ? { number: n, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp } : undefined);
    }
    return out;
  }
  async getTransactionInput(): Promise<Hex | undefined> { return undefined; }
}

type L = Omit<RpcLog, "blockNumber" | "transactionHash" | "logIndex">;
export function ev(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>): L {
  const item = (abi as readonly AbiEvent[]).find((entry) => entry.type === "event" && entry.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const plain = item.inputs.filter((input) => !input.indexed);
  const data = plain.length === 0 ? "0x" : encodeAbiParameters(plain, plain.map((input) => args[input.name!]) as never);
  return { address, data, topics };
}

export const listGear = (d: Deployment, id: Hex, market: Hex, token: Address, gear = 0): L =>
  ev(addressOf(d, "ODGearRegistry"), IODGearRegistryAbi as Abi, "GearListed", { id, marketA: market, marketB: `0x${"00".repeat(32)}`, gear, token, p0: 10n ** 18n, unitWad: 10n ** 18n });
export const transfer = (token: Address, from: Address, to: Address, value: bigint): L => ev(token, IODGearAbi as Abi, "Transfer", { from, to, value });
export const accrued = (d: Deployment, gearId: Hex, nf: bigint, toll = 1000n): L =>
  ev(addressOf(d, "ODMinter"), IODMinterAbi as Abi, "Accrued", { gearId, nf, tollPerSecWad: toll, dt: 3600n, tollValueUsdWad: 5n });
export const bought = (d: Deployment, gearId: Hex, who: Address, usdg: bigint, tokens: bigint, viaHook = false): L =>
  ev(addressOf(d, "ODMinter"), IODMinterAbi as Abi, "Bought", { gearId, payer: who, recipient: who, usdgIn: usdg, tokensOut: tokens, valuePerTokenWad: 10n ** 18n, spreadBps: 30, viaHook });
export const sellQueued = (d: Deployment, ticket: bigint, gearId: Hex, owner: Address, tokens: bigint): L =>
  ev(addressOf(d, "ODMinter"), IODMinterAbi as Abi, "SellQueued", { ticket, gearId, owner, tokens, minUsdgOut: 1n });
export const queueFilled = (d: Deployment, ticket: bigint): L => ev(addressOf(d, "ODMinter"), IODMinterAbi as Abi, "QueueFilled", { ticket, usdgOut: 7n, valuePerTokenWad: 10n ** 18n });
export const vaultOpened = (d: Deployment, vaultId: bigint, owner: Address, gearId: Hex): L => ev(addressOf(d, "ODBacker"), IODBackerAbi as Abi, "VaultOpened", { vaultId, owner, gearId });
export const collateralMoved = (d: Deployment, vaultId: bigint, delta: bigint, after: bigint): L => ev(addressOf(d, "ODBacker"), IODBackerAbi as Abi, "CollateralMoved", { vaultId, deltaUsdg: delta, collateralAfter: after });
export const vaultMinted = (d: Deployment, vaultId: bigint, tokens: bigint): L => ev(addressOf(d, "ODBacker"), IODBackerAbi as Abi, "Minted", { vaultId, tokens, soldToGovernor: true, proceedsUsdg: 1n });
export const volPosted = (d: Deployment, market: Hex, sigmaBps: bigint, validUntil: bigint): L => ev(addressOf(d, "ODVolOracle"), IODVolOracleAbi as Abi, "VolPosted", { market, sigmaBps, validUntil, nonce: 1n });
export const feeNotified = (d: Deployment, usdg: bigint, gearId: Hex = GEAR_1): L => ev(addressOf(d, "ODFees"), IODFeesAbi as Abi, "Notified", { kind: toHex("TOLL", { size: 32 }), gearId, usdg });

export const settings = (over: Partial<IndexerSettings> = {}): IndexerSettings => ({ confirmations: 0, catchupConcurrency: 1, snapshotHeartbeatMs: 600_000, ...over });

export function fakeReader(over: Partial<SnapshotReader> = {}): SnapshotReader {
  return {
    price: async () => ({ priceWad: 250n * 10n ** 18n, fresh: true, source: "chainlink", session: "OPEN" }),
    gear: async () => ({ supply: 1000n * 10n ** 18n, backerDebt: 200n * 10n ** 18n, valuePerTokenWad: 2n * 10n ** 18n }),
    governor: async () => ({ equity: 5_000_000n, exitReserve: 1_000_000n, exitReserveFloor: 500_000n }),
    hedgeDelta: async () => 123n,
    ...over,
  };
}

export async function newState(sql: Sql, chain: FakeChain, over: Partial<{ settings: IndexerSettings; reader: SnapshotReader; now: () => number }> = {}): Promise<IndexerState> {
  return createIndexerState({ settings: over.settings ?? settings(), source: chain, reader: over.reader ?? fakeReader(), sql, logger, deployment: testDeployment(), ...(over.now ? { now: over.now } : {}) });
}

export async function drain(state: IndexerState): Promise<void> {
  const ingest = createIngest(state);
  for (let i = 0; i < 50; i++) if ((await ingest.tick()).ingested === 0n) return;
}

export const TABLES = ["gears", "nf_history", "backer_vaults", "fees", "trades", "transfers", "balances", "vol_posts", "queued_sells", "liquidation_batches",
  "liquidations", "pause_log", "stock_events", "entity_events", "agent_policies", "agent_trades", "admin_events", "stake_events", "indexer_skipped_events"];

/** Every derived and event table as sorted JSON text (timestamps and serial ids left out), for row-for-row comparison. */
export async function dump(sql: Sql): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    const rows = await sql.unsafe(`SELECT * FROM ${table}`);
    out[table] = JSON.stringify(rows.map((row) => JSON.stringify(row, Object.keys(row).sort(), 0)).sort());
  }
  return out;
}

export async function resetDb(sql: Sql): Promise<void> {
  await sql.unsafe(`TRUNCATE ${[...TABLES, "cursors", "block_hashes", "reorg_log", "prices", "governor_ledger", "exit_reserve_log", "service_status"].join(", ")} RESTART IDENTITY`);
}

/** A small deterministic scenario generator: each call returns the logs of one block. */
export function randomBlockLogs(d: Deployment, rand: () => number, step: number): L[] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const logs: L[] = [];
  if (step === 0) {
    logs.push(listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1, 0), listGear(d, GEAR_2, MARKET_TSLA, TOKEN_2, 1));
    return logs;
  }
  const count = Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const roll = rand();
    const [gear, token] = pick([[GEAR_1, TOKEN_1], [GEAR_2, TOKEN_2]] as const);
    const user = pick(USERS);
    const other = pick(USERS);
    const amount = BigInt(1 + Math.floor(rand() * 1000));
    if (roll < 0.3) logs.push(transfer(token, ZERO, user, amount));
    else if (roll < 0.5) logs.push(transfer(token, user, other, amount));
    else if (roll < 0.6) logs.push(accrued(d, gear, 10n ** 18n - BigInt(Math.floor(rand() * 1000)), BigInt(Math.floor(rand() * 5000) - 1000)));
    else if (roll < 0.7) logs.push(bought(d, gear, user, amount, amount * 2n, rand() < 0.5));
    else if (roll < 0.75) logs.push(sellQueued(d, BigInt(step * 10 + i), gear, user, amount));
    else if (roll < 0.8) logs.push(queueFilled(d, BigInt(Math.max(1, (step - 1) * 10 + i))));
    else if (roll < 0.85) logs.push(vaultOpened(d, BigInt(step * 10 + i), user, gear));
    else if (roll < 0.9) logs.push(collateralMoved(d, BigInt(Math.max(1, (step - 1) * 10)), amount, amount * 3n));
    else if (roll < 0.95) logs.push(vaultMinted(d, BigInt(Math.max(1, (step - 1) * 10)), amount));
    else logs.push(feeNotified(d, amount, gear));
  }
  return logs;
}

export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
