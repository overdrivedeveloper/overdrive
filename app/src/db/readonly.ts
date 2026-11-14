import type { Sql } from "postgres";

export class WritableRoleError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`The API database role can write (${tables.slice(0, 5).join(", ")}${tables.length > 5 ? ", ..." : ""}). Use a SELECT-only role (scripts/api-readonly-role.sql).`);
    this.name = "WritableRoleError";
  }
}

/** R8: boot fails if the connecting role holds INSERT, UPDATE, DELETE or TRUNCATE on any table of the public schema, or can create there. */
export async function assertReadOnlyRole(sql: Sql): Promise<void> {
  const writable = await sql<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE')
        OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))
    ORDER BY c.relname`;
  const canCreate = (await sql<{ ok: boolean }[]>`SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok`)[0]?.ok === true;
  if (writable.length > 0 || canCreate) throw new WritableRoleError(canCreate && writable.length === 0 ? ["(schema public)"] : writable.map((r) => r.relname));
}
