import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import type { RuntimeConfig } from "../config";
import type { TxQueue } from "./tx";

/** What the indexer writes into service_status (job 'indexer'), plus the freshness fields read from the row itself. The
 * crank reads state from the chain; this is only the clock and the freshness signal. */
export interface IndexerMetadata {
  chainTimestamp?: number | string | null;
  lastHeadBlock?: string;
  indexedBlock?: string;
  lag?: string;
  indexerLastOk?: string;
  indexerLastError?: string | null;
}

export interface CrankContext {
  sql: Sql;
  clients: ServiceClients;
  deployment: Deployment;
  config: RuntimeConfig;
  logger: Logger;
  tx: TxQueue;
  metadata(): Promise<IndexerMetadata>;
  now(meta: IndexerMetadata): Date;
}

export async function readIndexerMetadata(sql: Sql): Promise<IndexerMetadata> {
  const rows = await sql<{ meta: IndexerMetadata; last_ok: Date | string | null; last_error: string | null }[]>`
    select meta, last_ok, last_error from service_status where job = 'indexer'`;
  const row = rows[0];
  if (!row) return {};
  return { ...row.meta, indexerLastOk: row.last_ok instanceof Date ? row.last_ok.toISOString() : row.last_ok ?? "", indexerLastError: row.last_error };
}

/** The crank's clock. On mainnet and testnet it is wall time. On the fork the chain can be warped, so the clock is the last
 * block time the indexer saw plus the wall time since the indexer last wrote it. */
export function chainClock(config: Pick<RuntimeConfig, "NETWORK">, meta: IndexerMetadata): Date {
  if (config.NETWORK !== "fork") return new Date();
  const chain = Number(meta.chainTimestamp);
  const observed = Date.parse(meta.indexerLastOk ?? "");
  if (!Number.isFinite(chain) || meta.chainTimestamp === null || !Number.isFinite(observed)) {
    throw new Error("Waiting for the indexer chain-time snapshot before running fork crank jobs");
  }
  return new Date(chain * 1000 + Math.max(0, Date.now() - observed));
}

export async function saveJobMeta(context: Pick<CrankContext, "sql">, job: string, meta: Record<string, unknown>): Promise<void> {
  await context.sql`insert into service_status (job, meta) values (${job}, ${JSON.stringify(meta)}::jsonb)
    on conflict (job) do update set meta = service_status.meta || excluded.meta`;
}

export async function readJobMeta(context: Pick<CrankContext, "sql">, job: string): Promise<Record<string, unknown>> {
  const rows = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from service_status where job = ${job}`;
  return rows[0]?.meta ?? {};
}

/** Fires a Telegram alert. The sender is installed by todo 14b; until then alerts are logged and kept in service_status. */
export type AlertSink = (level: "warn" | "critical", text: string, meta?: Record<string, unknown>) => Promise<void>;
