// Migrations for the fork database: runs the production migrator (src/bin/migrate.ts, drizzle) with the indexer env file, then
// prints how many migrations the database holds. Called by up.sh; safe to run again (0 applied the second time).
//   bun scripts/fork/migrate.ts
import postgres from "postgres";
import { APP, DATABASE_URL, readEnvFile } from "./lib";

const env = { ...process.env, ...readEnvFile("indexer") };
const p = Bun.spawnSync([process.execPath, "src/bin/migrate.ts"], { cwd: APP, env, stdout: "pipe", stderr: "pipe" });
process.stderr.write(p.stderr);
if (p.exitCode !== 0) {
  process.stderr.write(p.stdout);
  console.error(`migrate: failed (exit ${p.exitCode})`);
  process.exit(1);
}
const applied = /(\d+) applied/.exec(p.stdout.toString())?.[1] ?? "?";
const sql = postgres(env.DATABASE_URL ?? DATABASE_URL, { max: 1, onnotice: () => undefined });
try {
  const n = (await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.n ?? 0;
  const t = (await sql<{ t: number }[]>`select count(*)::int as t from information_schema.tables where table_schema = 'public'`)[0]?.t ?? 0;
  console.log(`migrate: ${applied} applied, ${n} migrations in the database, ${t} tables`);
} finally {
  await sql.end({ timeout: 5 });
}
