import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt } from "../units";
import { big, iso } from "./common";

/** Stock Token `UIMultiplierUpdated`, `OraclePaused`, `OracleUnpaused`: stored with `effective_at` so split days can be replayed (R17). */
export async function handleStockEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const kind = event.eventName === "UIMultiplierUpdated" ? "ui_multiplier" : event.eventName === "OraclePaused" ? "oracle_paused" : event.eventName === "OracleUnpaused" ? "oracle_unpaused" : undefined;
  if (!kind) return;
  const effective = kind === "ui_multiplier" ? new Date(Number(asBigInt(event.args.effectiveAtTimestamp)) * 1000).toISOString() : iso(event.ts);
  await context.tx`
    INSERT INTO stock_events (tx_hash, log_index, block, ts, token, kind, old_wad, new_wad, effective_at)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${event.address}, ${kind},
            ${kind === "ui_multiplier" ? big(event, "oldMultiplier") : null}, ${kind === "ui_multiplier" ? big(event, "newMultiplier") : null}, ${effective})
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
  context.kinds.add("oracle");
  context.snapshotNeeded = true;
}
