import type { ChainEvent, IndexerContext } from "../types";
import { bytes32Text, ZERO_BYTES32 } from "../units";
import { big, id32, iso } from "./common";

export async function handleFeesEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  let kind: string;
  let gear: string | null = null;
  let amount: string;
  if (event.eventName === "Notified") {
    kind = bytes32Text(event.args.kind).toLowerCase() || "notified";
    const g = id32(event, "gearId");
    gear = g === ZERO_BYTES32 ? null : g;
    amount = big(event, "usdg");
  } else if (event.eventName === "Distributed") {
    kind = "distributed";
    amount = big(event, "amount");
  } else return;
  await context.tx`
    INSERT INTO fees (ts, gear, kind, amount, block, tx_hash, log_index)
    VALUES (${iso(event.ts)}, ${gear}, ${kind}, ${amount}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex})
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
}
