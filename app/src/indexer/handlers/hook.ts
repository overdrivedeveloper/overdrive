import type { ChainEvent, IndexerContext } from "../types";
import { asNumber, sessionName } from "../units";
import { addr, big, id32, iso } from "./common";
import { change, handleAccrued, handleSettled } from "./gear";

async function insertTrade(
  context: IndexerContext, event: ChainEvent,
  t: { gear: string; account: string; recipient: string | null; side: "buy" | "sell"; tokens: string; usdg: string; value: string | null; spread: number | null; session: string | null; via: "hook" | "minter" | "queue" },
): Promise<void> {
  await context.tx`
    INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, recipient, side, tokens, usdg, value_per_token, spread_bps, session, via)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${t.gear}, ${t.account}, ${t.recipient}, ${t.side}, ${t.tokens}, ${t.usdg},
            ${t.value}, ${t.spread}, ${t.session}, ${t.via})
    ON CONFLICT (tx_hash, log_index) DO NOTHING`;
  context.kinds.add("trade");
  context.kinds.add("snapshot");
  context.snapshotNeeded = true;
}

/** Minter events: trades, the sell queue, accruals and settlement. */
export async function handleMinterEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const gear = id32(event, "gearId");
  switch (event.eventName) {
    case "Bought":
      return insertTrade(context, event, {
        gear, account: addr(event, "payer"), recipient: addr(event, "recipient"), side: "buy", tokens: big(event, "tokensOut"), usdg: big(event, "usdgIn"),
        value: big(event, "valuePerTokenWad"), spread: asNumber(event.args.spreadBps), session: null, via: event.args.viaHook ? "hook" : "minter",
      });
    case "Sold":
      return insertTrade(context, event, {
        gear, account: addr(event, "seller"), recipient: addr(event, "recipient"), side: "sell", tokens: big(event, "tokensIn"), usdg: big(event, "usdgOut"),
        value: big(event, "valuePerTokenWad"), spread: asNumber(event.args.spreadBps), session: sessionName(event.args.session), via: event.args.viaHook ? "hook" : "minter",
      });
    case "SellQueued":
      return change(context, event, "queue", big(event, "ticket"), "queued", { gear, account: addr(event, "owner"), tokens: big(event, "tokens"), minProceeds: big(event, "minUsdgOut") });
    case "QueueFilled": {
      const ticket = big(event, "ticket");
      const rows = await context.tx<{ gear: string; account: string; tokens: string }[]>`SELECT gear, account, tokens FROM queued_sells WHERE ticket = ${ticket}`;
      await change(context, event, "queue", ticket, "filled", {});
      if (rows[0]) {
        await insertTrade(context, event, {
          gear: rows[0].gear, account: rows[0].account, recipient: null, side: "sell", tokens: rows[0].tokens, usdg: big(event, "usdgOut"),
          value: big(event, "valuePerTokenWad"), spread: null, session: null, via: "queue",
        });
      }
      return;
    }
    case "QueueCancelled":
      return change(context, event, "queue", big(event, "ticket"), "cancelled", {});
    case "Accrued":
      return handleAccrued(context, event);
    case "GearSettled":
      return handleSettled(context, event);
  }
}
