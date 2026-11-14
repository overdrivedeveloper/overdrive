// Scan (R10): the indexed backer_vaults rows, worst first and bounded. A row is a HINT: nothing is sent on it (R3).
import type { Hex } from "viem";
import type { Sql } from "postgres";
import { candidateRows } from "../db/queries/liquidations";
import type { Candidate } from "./types";

const ID = /^\d{1,78}$/;
const GEAR = /^0x[0-9a-fA-F]{64}$/;

export interface ScanResult { candidates: Candidate[]; malformed: { id: string; reason: string }[] }

/** Rows from backer_vaults ordered by health ascending. Malformed rows are reported (R9), never thrown. `indexAgeS` is the age of
 * the indexer snapshot when known; older than `maxIndexAgeS` is flagged by the caller, but the chain re-read decides anyway. */
export async function scanCandidates(sql: Sql, opts: { limit: number; maxIndexAgeS: number; indexAgeS?: number | null }): Promise<Candidate[]> {
  return (await scanWithReport(sql, opts)).candidates;
}

export async function scanWithReport(sql: Sql, opts: { limit: number; maxIndexAgeS: number; indexAgeS?: number | null }): Promise<ScanResult> {
  const rows = await candidateRows(sql, opts.limit);
  const candidates: Candidate[] = [];
  const malformed: { id: string; reason: string }[] = [];
  for (const row of rows) {
    if (!ID.test(row.id) || !GEAR.test(row.gear) || !/^\d+$/.test(row.collateral) || !/^\d+$/.test(row.debt_tokens)) {
      malformed.push({ id: row.id, reason: "malformed indexed row" });
      continue;
    }
    candidates.push({
      vaultId: BigInt(row.id), gearId: row.gear.toLowerCase() as Hex, owner: row.owner,
      collateralUsdg: BigInt(row.collateral), debtTokens: BigInt(row.debt_tokens),
      healthHint: row.health && /^\d+$/.test(row.health) ? BigInt(row.health) : null, indexAgeS: opts.indexAgeS ?? null,
      ...(row.market_a && GEAR.test(row.market_a) ? { marketA: row.market_a.toLowerCase() as Hex } : {}),
      ...(row.market_b && GEAR.test(row.market_b) && !/^0x0{64}$/.test(row.market_b) ? { marketB: row.market_b.toLowerCase() as Hex } : {}),
    });
  }
  return { candidates, malformed };
}
