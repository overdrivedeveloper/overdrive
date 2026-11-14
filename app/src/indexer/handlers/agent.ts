import type { ChainEvent, IndexerContext } from "../types";
import { bytes32Text } from "../units";
import { addr, big, id32, iso, toJson } from "./common";
import { change } from "./gear";

export async function handleAgentEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const owner = addr(event, "owner");
  const agent = addr(event, "agent");
  const ref = `${owner}:${agent}`;
  if (event.eventName === "PolicySet") {
    await change(context, event, "policy", ref, "set", {
      owner, agent, budgetUsdg: big(event, "budgetUsdg"), expiresAt: big(event, "expiresAt"),
      detail: { maxPerTradeUsdg: big(event, "maxPerTradeUsdg"), canSell: Boolean(event.args.canSell), canBack: Boolean(event.args.canBack), markets: (event.args.markets as readonly string[] | undefined) ?? [] },
    });
  } else if (event.eventName === "PolicyRevoked") {
    await change(context, event, "policy", ref, "revoked", { owner, agent });
  } else if (event.eventName === "AgentTrade") {
    await context.tx`
      INSERT INTO agent_trades (tx_hash, log_index, block, ts, owner, agent, gear, side, tokens, usdg)
      VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${owner}, ${agent}, ${id32(event, "gearId")},
              ${bytes32Text(event.args.action).toLowerCase()}, NULL, ${big(event, "usdg")})
      ON CONFLICT (tx_hash, log_index) DO NOTHING`;
    context.kinds.add("trade");
  }
}
export { toJson };
