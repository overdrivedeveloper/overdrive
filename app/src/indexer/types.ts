import type { Logger } from "pino";
import type { TransactionSql } from "postgres";
import type { Address, Hex } from "viem";
import type { Deployment } from "../chain/deployment";

export interface RpcLog {
  readonly address: Address;
  readonly blockNumber: Hex | bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: Hex | number | null;
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

export interface BlockHeader {
  readonly number: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: Date;
}

export type EventSource = "registry" | "minter" | "governor" | "backer" | "oracleGuard" | "volOracle" | "fees" | "stake" | "agentRouter" | "admin" | "gear" | "stock";

export interface ChainEvent {
  readonly address: string;
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly ts: Date;
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  readonly source: EventSource;
}

export interface LogRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly addresses: readonly Address[];
  readonly stockAddresses: readonly Address[];
  readonly stockTopics: readonly Hex[];
}

/** Everything the ingest loop needs from the chain. Production reads it over the RPC pool; tests substitute a fake chain. */
export interface ChainSource {
  getHead(): Promise<bigint>;
  getLogs(range: LogRange): Promise<{ readonly logs: readonly RpcLog[]; readonly stockLogs: readonly RpcLog[] }>;
  /** Headers by number. A block the node does not have comes back as undefined. */
  getHeaders(numbers: readonly bigint[]): Promise<ReadonlyMap<bigint, BlockHeader | undefined>>;
  getTransactionInput(hash: string): Promise<Hex | undefined>;
  /**
   * The gear's current cap and spread from the registry, read at `block` when the node can serve that state, else at latest.
   * GearListed carries neither value, so the indexer asks the chain. Optional: a source without it leaves the configured defaults.
   */
  readGearParams?(gearId: Hex, block: bigint): Promise<{ readonly capUsdWad: bigint; readonly spreadBps: number } | undefined>;
}

export interface IndexerContext {
  readonly tx: TransactionSql;
  readonly deployment: Deployment;
  readonly logger: Logger;
  /** gear token address (lowercase) -> gear id */
  readonly gearByToken: Map<string, string>;
  /** (token, account) pairs whose balance must be recomputed from the transfers table. */
  readonly touchedBalances: Map<string, { token: string; account: string }>;
  /** Gear tokens listed in this batch: they are watched from the next range on. */
  readonly newTokens: string[];
  /** Reads a listed gear's cap and spread from the chain (see ChainSource.readGearParams). */
  readonly readGearParams?: ChainSource["readGearParams"];
  readonly kinds: Set<"trade" | "oracle" | "snapshot" | "liquidation" | "config">;
  /** A trade, accrual or book change happened: the ledger must be re-snapshotted. */
  snapshotNeeded: boolean;
}
