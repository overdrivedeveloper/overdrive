// Liquidator reads (backer_vaults as a hint) and its own run and attempt log (drizzle/0006_liquidator.sql).
import type { Sql } from "postgres";

export interface CandidateRow { id: string; owner: string; gear: string; collateral: string; debt_tokens: string; health: string | null; updated_block: string | null; market_a: string | null; market_b: string | null }

/** Open vaults with debt, worst first: by the indexed health when the indexer wrote one, then by collateral per debt token (a
 * proxy inside one gear). Bounded by `limit`. */
export async function candidateRows(sql: Sql, limit: number): Promise<CandidateRow[]> {
  return sql<CandidateRow[]>`
    select v.id::text, v.owner, v.gear, v.collateral::text, v.debt_tokens::text, v.health::text, v.updated_block::text, g.market_a, g.market_b
    from backer_vaults v left join gears g on g.id = v.gear
    where v.status = 'open' and v.debt_tokens > 0
    order by v.health asc nulls last, (v.collateral / v.debt_tokens) asc, v.id asc
    limit ${limit}`;
}

export type RunPhase = "verified" | "simulated" | "sealed" | "executed" | "executed_by_other" | "voided" | "abandoned";

export interface RunInsert { batchId?: bigint | null; gear: string; vaultIds: readonly bigint[]; phase: RunPhase; sealTx?: string | null; error?: string | null }

export async function insertRun(sql: Sql, run: RunInsert): Promise<bigint> {
  const ids = `{${run.vaultIds.map(String).join(",")}}`; // digits only: a safe array literal
  const rows = await sql<{ id: string }[]>`
    insert into liquidation_runs (batch_id, gear, vault_ids, phase, seal_tx, error)
    values (${run.batchId === undefined || run.batchId === null ? null : run.batchId.toString()}, ${run.gear}, ${ids}::numeric[], ${run.phase},
      ${run.sealTx ?? null}, ${run.error ?? null})
    returning id::text`;
  return BigInt(rows[0]!.id);
}

export interface RunUpdate { phase: RunPhase; executeTx?: string | null; bonusUsdg?: bigint | null; badDebtUsdg?: bigint | null; coveredUsdg?: bigint | null; error?: string | null }

/** Updates the latest run row of a batch, inserting one if this service never saw the seal (another liquidator sealed it). */
export async function closeRun(sql: Sql, batchId: bigint, gear: string, vaultIds: readonly bigint[], update: RunUpdate): Promise<void> {
  const s = (v: bigint | null | undefined) => (v === undefined || v === null ? null : v.toString());
  const updated = await sql`
    update liquidation_runs set phase = ${update.phase}, execute_tx = coalesce(${update.executeTx ?? null}, execute_tx),
      bonus_usdg = ${s(update.bonusUsdg)}, bad_debt_usdg = ${s(update.badDebtUsdg)}, covered_usdg = ${s(update.coveredUsdg)}, error = ${update.error ?? null}
    where id = (select id from liquidation_runs where batch_id = ${batchId.toString()} order by id desc limit 1)`;
  if (updated.count === 0) {
    const id = await insertRun(sql, { batchId, gear, vaultIds, phase: update.phase, error: update.error ?? null });
    await sql`update liquidation_runs set execute_tx = ${update.executeTx ?? null}, bonus_usdg = ${s(update.bonusUsdg)},
      bad_debt_usdg = ${s(update.badDebtUsdg)}, covered_usdg = ${s(update.coveredUsdg)} where id = ${id.toString()}`;
  }
}

export interface AttemptRow { vaultId: bigint; gear: string | null; verdict: string; ratioBps?: bigint | null; requiredBps?: bigint | null; reason?: string | null }

export async function insertAttempts(sql: Sql, rows: readonly AttemptRow[]): Promise<void> {
  if (!rows.length) return;
  const values = rows.map((r) => ({
    vault_id: r.vaultId.toString(), gear: r.gear, verdict: r.verdict,
    ratio_bps: r.ratioBps === undefined || r.ratioBps === null ? null : r.ratioBps.toString(),
    required_bps: r.requiredBps === undefined || r.requiredBps === null ? null : r.requiredBps.toString(), reason: r.reason ?? null,
  }));
  await sql`insert into liquidation_attempts ${sql(values, "vault_id", "gear", "verdict", "ratio_bps", "required_bps", "reason")}`;
}

export async function latestRuns(sql: Sql, limit = 50) {
  return sql<{ batch_id: string | null; gear: string; vault_ids: string[]; phase: RunPhase; bonus_usdg: string | null; bad_debt_usdg: string | null; covered_usdg: string | null; error: string | null }[]>`
    select batch_id::text, gear, vault_ids::text[], phase, bonus_usdg::text, bad_debt_usdg::text, covered_usdg::text, error
    from liquidation_runs order by id desc limit ${limit}`;
}
