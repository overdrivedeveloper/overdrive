import type { Sql } from "postgres";
/** Distinct wallets that did a real buy, sell or back, minus the excluded set (all lowercase). Backing = owning a vault. */
export async function realUsers(sql: Sql, excluded: readonly string[]) {
  const ex = [...excluded, "0x0000000000000000000000000000000000000000"];
  const [row] = await sql<{ traders: string; backers: string; total: string; both: string; first_at: Date | null }[]>`
    WITH t AS (SELECT DISTINCT lower(account) AS a FROM trades WHERE NOT (lower(account) = ANY(${ex}::text[]))),
         b AS (SELECT DISTINCT lower(owner) AS a FROM backer_vaults WHERE NOT (lower(owner) = ANY(${ex}::text[]))),
         f AS (SELECT MIN(ts) AS first_at FROM trades WHERE NOT (lower(account) = ANY(${ex}::text[])))
    SELECT (SELECT COUNT(*) FROM t)::text AS traders, (SELECT COUNT(*) FROM b)::text AS backers,
           (SELECT COUNT(*) FROM (SELECT a FROM t UNION SELECT a FROM b) u)::text AS total,
           (SELECT COUNT(*) FROM (SELECT a FROM t INTERSECT SELECT a FROM b) i)::text AS both,
           (SELECT first_at FROM f) AS first_at`;
  return { traders: Number(row!.traders), backers: Number(row!.backers), total: Number(row!.total), both: Number(row!.both), firstAt: row!.first_at };
}
