// Applies replayable entity changes (entity_events) to the derived tables, and rebuilds touched entities after a rollback.
import type { TransactionSql } from "postgres";
import type { Deployment } from "../../chain/deployment";
import { wadToUsdg } from "../../lib/fixed";
import { GEAR_NAMES, GEAR_POWER_TEXT, GEAR_POWER_WAD, ZERO_BYTES32, asNumber } from "../units";

export interface EntityChange {
  readonly scope: string;
  readonly ref: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
  readonly block: bigint;
  readonly ts: Date;
}

const str = (data: Record<string, unknown>, key: string): string => String(data[key] ?? "0");

export async function applyEntity(tx: TransactionSql, deployment: Deployment, change: EntityChange): Promise<void> {
  const { scope, ref, kind, data } = change;
  const block = change.block.toString();
  const ts = change.ts.toISOString();
  if (scope === "gear") {
    if (kind === "listed") {
      const index = asNumber(data.gear, 0);
      const marketA = str(data, "marketA");
      const marketB = data.marketB ? String(data.marketB) : null;
      const markets = new Map(deployment.markets.map((m) => [m.id.toLowerCase(), m.symbol]));
      const configured = deployment.gears.find((g) => g.id.toLowerCase() === ref);
      const symbolA = markets.get(marketA) ?? marketA;
      const symbolB = marketB ? (markets.get(marketB) ?? marketB) : null;
      await tx`
        INSERT INTO gears (id, market_a, market_b, underlying, underlying_b, power, power_wad, token, cap_usd, spread_bps, status, listed_block, listed_at)
        VALUES (${ref}, ${marketA}, ${marketB}, ${symbolA}, ${symbolB}, ${GEAR_POWER_TEXT[index] ?? "1"}, ${(GEAR_POWER_WAD[index] ?? 0n).toString()},
                ${str(data, "token")}, ${configured?.capUsd ?? "0"}, ${configured?.spreadBps ?? 0}, 'active', ${block}, ${ts})
        ON CONFLICT (id) DO NOTHING`;
    } else if (kind === "params") {
      await tx`UPDATE gears SET cap_usd = ${wadToUsdg(BigInt(str(data, "capUsdWad"))).toString()}, spread_bps = ${asNumber(data.spreadBps)} WHERE id = ${ref}`;
    } else if (kind === "status") {
      await tx`UPDATE gears SET status = ${str(data, "status")} WHERE id = ${ref}`;
    }
  } else if (scope === "vault") {
    if (kind === "opened") {
      await tx`INSERT INTO backer_vaults (id, owner, gear, collateral, debt_tokens, status, opened_block, updated_block)
        VALUES (${ref}, ${str(data, "owner")}, ${str(data, "gear")}, 0, 0, 'open', ${block}, ${block}) ON CONFLICT (id) DO NOTHING`;
    } else if (kind === "collateral") {
      await tx`UPDATE backer_vaults SET collateral = ${str(data, "after")}, updated_block = ${block} WHERE id = ${ref}`;
    } else if (kind === "minted") {
      await tx`UPDATE backer_vaults SET debt_tokens = debt_tokens + ${str(data, "tokens")}, updated_block = ${block} WHERE id = ${ref}`;
    } else if (kind === "repaid") {
      await tx`UPDATE backer_vaults SET debt_tokens = debt_tokens - ${str(data, "tokens")}, updated_block = ${block} WHERE id = ${ref}`;
    } else if (kind === "liquidated") {
      await tx`UPDATE backer_vaults SET debt_tokens = GREATEST(debt_tokens - ${str(data, "debtTokens")}, 0), collateral = GREATEST(collateral - ${str(data, "collateralSeized")}, 0),
        updated_block = ${block} WHERE id = ${ref}`;
      await tx`UPDATE backer_vaults SET status = CASE WHEN debt_tokens = 0 THEN 'closed' ELSE 'open' END WHERE id = ${ref}`;
    } else if (kind === "liquidating") {
      await tx`UPDATE backer_vaults SET status = 'liquidating', updated_block = ${block} WHERE id = ${ref}`;
    } else if (kind === "released") {
      await tx`UPDATE backer_vaults SET status = CASE WHEN debt_tokens = 0 THEN 'closed' ELSE 'open' END, updated_block = ${block} WHERE id = ${ref} AND status = 'liquidating'`;
    }
  } else if (scope === "queue") {
    if (kind === "queued") {
      await tx`INSERT INTO queued_sells (ticket, gear, account, tokens, min_proceeds, queued_block, queued_at, status)
        VALUES (${ref}, ${str(data, "gear")}, ${str(data, "account")}, ${str(data, "tokens")}, ${str(data, "minProceeds")}, ${block}, ${ts}, 'open') ON CONFLICT (ticket) DO NOTHING`;
    } else if (kind === "filled") {
      await tx`UPDATE queued_sells SET status = 'filled', filled_block = ${block} WHERE ticket = ${ref}`;
    } else if (kind === "cancelled") {
      await tx`UPDATE queued_sells SET status = 'cancelled', filled_block = ${block} WHERE ticket = ${ref}`;
    }
  } else if (scope === "batch") {
    if (kind === "sealed") {
      const ids = (data.vaultIds as string[] | undefined) ?? [];
      await tx`INSERT INTO liquidation_batches (batch_id, gear, sealed_value_wad, sealed_at, vault_ids, status, sealed_block)
        VALUES (${ref}, ${str(data, "gear")}, ${str(data, "sealedValueWad")}, ${ts}, ${`{${ids.join(",")}}`}::numeric[], 'sealed', ${block}) ON CONFLICT (batch_id) DO NOTHING`;
    } else if (kind === "executed") {
      await tx`UPDATE liquidation_batches SET status = 'executed', closed_block = ${block} WHERE batch_id = ${ref}`;
    } else if (kind === "voided") {
      await tx`UPDATE liquidation_batches SET status = 'voided', closed_block = ${block}, void_reason = ${str(data, "reason")} WHERE batch_id = ${ref}`;
    }
  } else if (scope === "policy") {
    if (kind === "set") {
      await tx`INSERT INTO agent_policies (owner, agent, budget_usdg, expires_at, revoked, detail, updated_block, tx_hash, log_index)
        VALUES (${str(data, "owner")}, ${str(data, "agent")}, ${str(data, "budgetUsdg")}, ${new Date(Number(str(data, "expiresAt")) * 1000).toISOString()}, false, ${JSON.stringify(data.detail ?? {})}::jsonb, ${block}, '', 0)
        ON CONFLICT (owner, agent) DO UPDATE SET budget_usdg = EXCLUDED.budget_usdg, expires_at = EXCLUDED.expires_at, revoked = false, detail = EXCLUDED.detail, updated_block = EXCLUDED.updated_block`;
    } else if (kind === "revoked") {
      await tx`UPDATE agent_policies SET revoked = true, updated_block = ${block} WHERE owner = ${str(data, "owner")} AND agent = ${str(data, "agent")}`;
    }
  }
}

/** Deletes the derived rows of the given entities and replays their stored changes in chain order. */
export async function rebuildEntities(tx: TransactionSql, deployment: Deployment, keys: readonly { scope: string; ref: string }[]): Promise<void> {
  const byScope = new Map<string, string[]>();
  for (const key of keys) byScope.set(key.scope, [...(byScope.get(key.scope) ?? []), key.ref]);
  const refs = (scope: string) => byScope.get(scope) ?? [];
  if (refs("gear").length) await tx`DELETE FROM gears WHERE id IN ${tx(refs("gear"))}`;
  if (refs("vault").length) await tx`DELETE FROM backer_vaults WHERE id IN ${tx(refs("vault"))}`;
  if (refs("queue").length) await tx`DELETE FROM queued_sells WHERE ticket IN ${tx(refs("queue"))}`;
  if (refs("batch").length) await tx`DELETE FROM liquidation_batches WHERE batch_id IN ${tx(refs("batch"))}`;
  for (const ref of refs("policy")) {
    const [owner, agent] = ref.split(":");
    await tx`DELETE FROM agent_policies WHERE owner = ${owner!} AND agent = ${agent!}`;
  }
  for (const [scope, list] of byScope) {
    const rows = await tx<{ scope: string; ref: string; kind: string; data: Record<string, unknown>; block: string; ts: Date }[]>`
      SELECT scope, ref, kind, data, block, ts FROM entity_events WHERE scope = ${scope} AND ref IN ${tx(list)} ORDER BY block, log_index`;
    for (const row of rows) await applyEntity(tx, deployment, { scope: row.scope, ref: row.ref, kind: row.kind, data: row.data, block: BigInt(row.block), ts: new Date(row.ts) });
  }
}

export { GEAR_NAMES, ZERO_BYTES32 };
