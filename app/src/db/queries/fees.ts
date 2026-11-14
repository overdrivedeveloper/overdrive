import type { Sql } from "postgres";
export const feeTotals = (sql: Sql) => sql<{ kind: string; total: string; last: Date | null }[]>`
  SELECT kind, SUM(amount)::text AS total, MAX(ts) AS last FROM fees GROUP BY kind ORDER BY kind`;
