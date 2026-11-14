import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLogger, safeErrorSummary } from "../log";
import { loadConfig, safeConfigSummary } from "../config";
import { EXIT_NOT_SWITCHED, migrateWithLockRetry } from "../db/migrate-retry";
import * as schema from "../db/schema";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "migrate");
// One session with lock_timeout: an ALTER waiting behind live API queries gives up after 5 s instead of making every API
// query queue behind its lock (the migrator runs in one transaction, which is rolled back on the timeout).
const sql = postgres(config.DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => undefined, connection: { lock_timeout: 5000 } });
const db = drizzle(sql, { schema });

try {
  logger.info({ config: safeConfigSummary(config) }, "Applying database migrations");
  const countApplied = async (): Promise<number> => {
    const exists = await sql<{ present: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations') as present`;
    if (!exists[0]?.present) return 0;
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return rows[0]?.n ?? 0;
  };
  const before = await countApplied();
  const r = await migrateWithLockRetry(() => migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") }), 3, 5000);
  if (r.ok) {
    const applied = (await countApplied()) - before;
    logger.info({ attempts: r.attempts, applied }, "Database migrations complete");
    console.log(`${applied} applied`);
  } else if (r.lockTimeout) {
    logger.error({ attempts: r.attempts }, "Database migrations gave up: lock timeout every time (nothing applied); try again later");
    process.exitCode = EXIT_NOT_SWITCHED;
  } else {
    logger.error({ err: safeErrorSummary(r.error) }, "Database migration failed");
    process.exitCode = 1;
  }
} catch (error) {
  logger.error({ err: safeErrorSummary(error) }, "Database migration failed");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
