import type { Sql } from "postgres";
export interface VaultRow { id: string; owner: string; gear: string; collateral: string; debtTokens: string; status: string; updatedBlock: string | null }
const cols = (sql: Sql) => sql`id::text AS id, owner, gear, collateral::text AS collateral, debt_tokens::text AS "debtTokens", status, updated_block::text AS "updatedBlock"`;
export const vaultsOf = (sql: Sql, owner: string) => sql<VaultRow[]>`SELECT ${cols(sql)} FROM backer_vaults WHERE owner = ${owner.toLowerCase()} ORDER BY id`;
export const vaultById = async (sql: Sql, id: string) => (await sql<VaultRow[]>`SELECT ${cols(sql)} FROM backer_vaults WHERE id = ${id}`)[0];
