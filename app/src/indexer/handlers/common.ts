import type { TransactionSql } from "postgres";
import type { ChainEvent } from "../types";
import { asAddress, ZERO_ADDRESS, ZERO_BYTES32 } from "../units";

export const arg = (event: ChainEvent, key: string, fallback?: unknown): unknown => event.args[key] ?? fallback;
export const addr = (event: ChainEvent, key: string): string => asAddress(arg(event, key, ZERO_ADDRESS));
export const id32 = (event: ChainEvent, key: string): string => String(arg(event, key, ZERO_BYTES32)).toLowerCase();
export const iso = (date: Date): string => date.toISOString();
export const big = (event: ChainEvent, key: string): string => String(arg(event, key, 0n));

/** JSON with bigints as decimal strings. */
export const toJson = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/** Stores one replayable entity change. Returns false when this exact change was already stored (replay of the same range). */
export async function recordEntity(
  tx: TransactionSql,
  event: ChainEvent,
  scope: string,
  ref: string,
  kind: string,
  data: Record<string, unknown> = {},
): Promise<boolean> {
  const rows = await tx`
    INSERT INTO entity_events (tx_hash, log_index, block, ts, scope, ref, kind, data)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${scope}, ${ref}, ${kind}, ${toJson(data)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING 1`;
  return rows.length > 0;
}
