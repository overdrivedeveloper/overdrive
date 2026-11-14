import type { TransactionSql } from "postgres";
import type { Deployment } from "../chain/deployment";
import { rebuildEntities } from "./handlers/entities";
import { recomputeNf } from "./handlers/gear";
import { recomputeBalances } from "./handlers/index";

export interface RollbackSummary {
  readonly ancestor: bigint;
  readonly rowsRemoved: number;
}

/** Tables whose rows hold the block that produced them; rollback deletes everything above the common ancestor. */
const BLOCK_TABLES: readonly [string, string][] = [
  ["nf_history", "block"], ["fees", "block"], ["trades", "block"], ["transfers", "block"], ["prices", "block"], ["vol_posts", "block"],
  ["liquidations", "block"], ["pause_log", "block"], ["stock_events", "block"], ["exit_reserve_log", "block"], ["stake_events", "block"],
  ["agent_trades", "block"], ["admin_events", "block"], ["governor_ledger", "block"], ["indexer_skipped_events", "block"], ["block_hashes", "block"],
];

/**
 * Removes everything the orphaned blocks produced and recomputes what is derived from event history: gears (status, cap, nf),
 * backer vaults, queued sells, liquidation batches and agent policies by replaying their stored changes, gears.nf from
 * nf_history, balances from transfers. Runs inside the caller's transaction.
 */
export async function rollbackAfter(tx: TransactionSql, deployment: Deployment, ancestor: bigint): Promise<RollbackSummary> {
  const above = ancestor.toString();
  const entityRows = await tx<{ scope: string; ref: string; kind: string; data: Record<string, unknown> }[]>`
    SELECT DISTINCT scope, ref, kind, data FROM entity_events WHERE block > ${above}`;
  const keys = new Map<string, { scope: string; ref: string }>();
  for (const row of entityRows) {
    keys.set(`${row.scope}:${row.ref}`, { scope: row.scope, ref: row.ref });
    if (row.scope === "batch" && row.kind === "sealed") {
      for (const id of (row.data.vaultIds as string[] | undefined) ?? []) keys.set(`vault:${id}`, { scope: "vault", ref: id });
    }
  }
  const transferRows = await tx<{ token: string; from_addr: string; to_addr: string }[]>`SELECT DISTINCT token, from_addr, to_addr FROM transfers WHERE block > ${above}`;
  const pairs = new Map<string, { token: string; account: string }>();
  for (const row of transferRows) {
    for (const account of [row.from_addr, row.to_addr]) {
      if (account !== "0x0000000000000000000000000000000000000000") pairs.set(`${row.token}:${account}`, { token: row.token, account });
    }
  }
  const nfGears = (await tx<{ gear: string }[]>`SELECT DISTINCT gear FROM nf_history WHERE block > ${above}`).map((row) => row.gear);

  let rowsRemoved = 0;
  for (const [table, column] of BLOCK_TABLES) {
    const removed = await tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} > ${above} RETURNING 1`;
    rowsRemoved += removed.length;
  }
  rowsRemoved += (await tx`DELETE FROM entity_events WHERE block > ${above} RETURNING 1`).length;

  await rebuildEntities(tx, deployment, [...keys.values()]);
  const gearRefs = [...keys.values()].filter((key) => key.scope === "gear").map((key) => key.ref);
  await recomputeNf(tx, [...new Set([...nfGears, ...gearRefs])]);
  await recomputeBalances(tx, pairs.values());
  await tx`UPDATE cursors SET block = ${above}, updated_at = NOW() WHERE name = 'main'`;
  return { ancestor, rowsRemoved };
}
