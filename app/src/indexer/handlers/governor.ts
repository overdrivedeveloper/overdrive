import type { ChainEvent, IndexerContext } from "../types";
import { big, iso } from "./common";

/** Governor events. Ledger rows come from snapshots (R15); events only trigger them and keep the exit-reserve and pause logs. */
export async function handleGovernorEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const { tx } = context;
  const block = event.blockNumber.toString();
  switch (event.eventName) {
    case "ExitReserveMoved": {
      const floor = await tx<{ floor: string }[]>`SELECT "floor" FROM exit_reserve_log ORDER BY block DESC, log_index DESC LIMIT 1`;
      await tx`
        INSERT INTO exit_reserve_log (ts, block, tx_hash, log_index, balance, "floor", ring_fenced)
        VALUES (${iso(event.ts)}, ${block}, ${event.txHash}, ${event.logIndex}, ${big(event, "balanceAfter")}, ${floor[0]?.floor ?? "0"}, true)
        ON CONFLICT DO NOTHING`;
      break;
    }
    case "BuysPausedSet":
      await tx`
        INSERT INTO pause_log (ts, block, tx_hash, log_index, scope, ref, action, actor, reason)
        VALUES (${iso(event.ts)}, ${block}, ${event.txHash}, ${event.logIndex}, 'global', NULL, ${event.args.paused ? "pause" : "unpause"}, NULL, 'governor')
        ON CONFLICT DO NOTHING`;
      break;
    case "BookUpdated":
    case "HedgePosted":
    case "RiskPoked":
    case "PaidOut":
    case "SentToHedger":
      break;
    default:
      return; // vault share transfers and deposits are not indexed
  }
  context.snapshotNeeded = true;
  context.kinds.add("snapshot");
}
