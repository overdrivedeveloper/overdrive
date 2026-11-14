import type { TransactionSql } from "postgres";
import { toBigInt } from "../../lib/fixed";
import type { ChainEvent, IndexerContext } from "../types";
import { asAddress, ZERO_ADDRESS } from "../units";
import { handleAgentEvent } from "./agent";
import { handleBackerEvent } from "./backer";
import { addr, big, iso } from "./common";
import { handleFeesEvent } from "./fees";
import { handleRegistryEvent } from "./gear";
import { handleGovernorEvent } from "./governor";
import { handleMinterEvent } from "./hook";
import { handleAdminEvent, handleOracleEvent } from "./oracle";
import { handleStakeEvent } from "./stake";
import { handleStockEvent } from "./stock";

/** A gear token Transfer: stored, and the two balances are marked for recomputation from the transfers table. */
async function handleTransfer(context: IndexerContext, event: ChainEvent): Promise<void> {
  const from = addr(event, "from");
  const to = addr(event, "to");
  await context.tx`
    INSERT INTO transfers (tx_hash, log_index, block, ts, token, from_addr, to_addr, amount)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${event.address}, ${from}, ${to}, ${big(event, "value")})
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
  for (const account of [from, to]) {
    if (account !== ZERO_ADDRESS) context.touchedBalances.set(`${event.address}:${account}`, { token: event.address, account });
  }
}

export async function handleEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  switch (event.source) {
    case "registry": return handleRegistryEvent(context, event);
    case "minter": return handleMinterEvent(context, event);
    case "governor": return handleGovernorEvent(context, event);
    case "backer": return handleBackerEvent(context, event);
    case "oracleGuard":
    case "volOracle": return handleOracleEvent(context, event);
    case "fees": return handleFeesEvent(context, event);
    case "stake": return handleStakeEvent(context, event);
    case "agentRouter": return handleAgentEvent(context, event);
    case "admin": return handleAdminEvent(context, event);
    case "gear": return event.eventName === "Transfer" ? handleTransfer(context, event) : undefined;
    case "stock": return handleStockEvent(context, event);
  }
}

/** balance(token, account) = sum of transfers in minus sum out, for the given pairs. Rows are kept at 0. */
export async function recomputeBalances(tx: TransactionSql, pairs: Iterable<{ token: string; account: string }>): Promise<void> {
  for (const { token, account } of pairs) {
    const rows = await tx<{ balance: string | null }[]>`
      SELECT COALESCE(SUM(CASE WHEN to_addr = ${account} THEN amount ELSE 0 END) - SUM(CASE WHEN from_addr = ${account} THEN amount ELSE 0 END), 0) AS balance
      FROM transfers WHERE token = ${token} AND (to_addr = ${account} OR from_addr = ${account})`;
    const history = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM transfers WHERE token = ${token} AND (to_addr = ${account} OR from_addr = ${account})`;
    if (history[0]!.n === 0) {
      await tx`DELETE FROM balances WHERE token = ${token} AND account = ${account}`;
      continue;
    }
    const balance = toBigInt(rows[0]?.balance).toString();
    await tx`INSERT INTO balances (token, account, balance) VALUES (${token}, ${account}, ${balance})
      ON CONFLICT (token, account) DO UPDATE SET balance = EXCLUDED.balance`;
  }
}

function skipReason(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

export async function recordSkipped(tx: TransactionSql, row: { block: bigint; txHash: string; logIndex: number; address: string; reason: string }): Promise<void> {
  await tx`
    INSERT INTO indexer_skipped_events (block, tx_hash, log_index, address, reason)
    VALUES (${row.block.toString()}, ${row.txHash}, ${row.logIndex}, ${asAddress(row.address)}, ${row.reason})
    ON CONFLICT (tx_hash, log_index) DO UPDATE SET reason = EXCLUDED.reason`;
}

/**
 * Applies a batch in chain order, then settles derived balances. Every event runs inside its own SAVEPOINT: an event that
 * throws is rolled back alone, recorded in indexer_skipped_events and logged, and ingestion goes on (R13). Returns the skip count.
 */
export async function handleEvents(context: IndexerContext, events: readonly ChainEvent[]): Promise<number> {
  let skipped = 0;
  for (const event of events) {
    await context.tx.unsafe("SAVEPOINT od_event");
    try {
      await handleEvent(context, event);
      await context.tx.unsafe("RELEASE SAVEPOINT od_event");
    } catch (error) {
      await context.tx.unsafe("ROLLBACK TO SAVEPOINT od_event");
      await context.tx.unsafe("RELEASE SAVEPOINT od_event");
      const reason = skipReason(error);
      skipped += 1;
      context.logger.error({ source: event.source, event: event.eventName, tx: event.txHash, logIndex: event.logIndex, block: event.blockNumber.toString(), reason }, "Indexer skipped an event it could not apply; ingestion continues");
      await recordSkipped(context.tx, { block: event.blockNumber, txHash: event.txHash, logIndex: event.logIndex, address: event.address, reason });
    }
  }
  await recomputeBalances(context.tx, context.touchedBalances.values());
  return skipped;
}
