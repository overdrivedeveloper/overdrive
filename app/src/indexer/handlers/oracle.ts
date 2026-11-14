import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, bytes32Text } from "../units";
import { addr, big, id32, iso, toJson } from "./common";

async function pause(context: IndexerContext, event: ChainEvent, scope: string, ref: string | null, action: "pause" | "unpause", reason: string): Promise<void> {
  await context.tx`
    INSERT INTO pause_log (ts, block, tx_hash, log_index, scope, ref, action, actor, reason)
    VALUES (${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}, ${scope}, ${ref}, ${action}, NULL, ${reason})
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
}

/** Oracle guard, vol oracle and the timelock / guardian Safe. Prices come from snapshots; events only trigger them. */
export async function handleOracleEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const market = id32(event, "market");
  switch (event.eventName) {
    case "BuysPausedSet":
      await pause(context, event, "underlying", market, event.args.paused ? "pause" : "unpause", bytes32Text(event.args.reason));
      break;
    case "HaltLatched":
      await pause(context, event, "underlying", market, "pause", "halt");
      break;
    case "VolPosted":
      await context.tx`
        INSERT INTO vol_posts (gear_or_underlying, ts, block, tx_hash, log_index, sigma_bps, valid_until, signer)
        VALUES (${market}, ${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}, ${big(event, "sigmaBps")},
                ${new Date(Number(asBigInt(event.args.validUntil)) * 1000).toISOString()}, NULL)
        ON CONFLICT (tx_hash, log_index) DO NOTHING`;
      break;
    case "LastGoodSet":
    case "MarketSet":
      context.kinds.add("config");
      break;
    default:
      return;
  }
  context.kinds.add("oracle");
  context.snapshotNeeded = true;
}

/** Timelock `CallScheduled`, `CallExecuted`, `Cancelled` and the guardian Safe's `ExecutionSuccess`, for the crank's admin-watch. */
export async function handleAdminEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const timelock = event.address === context.deployment.admin.timelock.toLowerCase();
  let kind: string;
  let opId: string;
  let target: string | null = null;
  let eta: string | null = null;
  switch (event.eventName) {
    case "CallScheduled":
      kind = "scheduled";
      opId = id32(event, "id");
      target = addr(event, "target");
      eta = new Date(event.ts.getTime() + Number(asBigInt(event.args.delay)) * 1000).toISOString();
      break;
    case "CallExecuted":
      kind = "executed"; opId = id32(event, "id"); target = addr(event, "target");
      break;
    case "Cancelled":
      kind = "cancelled"; opId = id32(event, "id");
      break;
    case "ExecutionSuccess":
      kind = "executed"; opId = id32(event, "txHash");
      break;
    default:
      return;
  }
  await context.tx`
    INSERT INTO admin_events (tx_hash, log_index, block, ts, source, kind, op_id, target, eta, detail)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${timelock ? "timelock" : "guardian"}, ${kind}, ${opId}, ${target}, ${eta},
            ${toJson({ index: event.args.index ?? null })}::jsonb)
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
}
