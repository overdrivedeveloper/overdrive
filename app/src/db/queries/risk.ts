import type { Sql } from "postgres";
export const latestRiskRun = async (sql: Sql) => (await sql<{ ts: Date | null; meta: Record<string, unknown> }[]>`
  SELECT COALESCE(last_ok, last_run) AS ts, meta FROM service_status WHERE job = 'risk-sim' LIMIT 1`)[0];
