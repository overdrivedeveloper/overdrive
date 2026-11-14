import type { ChainEvent, IndexerContext } from "../types";
import { iso, toJson } from "./common";

export async function handleStakeEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const a = event.args;
  const account = typeof a.account === "string" ? a.account.toLowerCase() : null;
  const amount = a.amount ?? a.usdg ?? a.usdgRequested ?? a.shares ?? null;
  await context.tx`
    INSERT INTO stake_events (tx_hash, log_index, block, ts, kind, account, amount, detail)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${event.eventName}, ${account}, ${amount === null ? null : String(amount)}, ${toJson(a)}::jsonb)
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
}
