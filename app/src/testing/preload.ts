import { afterAll } from "bun:test";
import { optionalEnv, setTestDatabaseEnv } from "../config";
import { startEphemeralPostgres } from "./pg";

// `bun test` preload: give the database tests a throwaway Postgres unless the caller supplied one.
// Locally the database tests skip when no Postgres is installed. In CI (CI=true) a missing database fails the run
// instead, so a green CI always includes the database tests.
// CI is not a service variable, so it is read here directly rather than through config.ts.
const inCi = optionalEnv("CI")?.trim() === "true";
if (!optionalEnv("TEST_DATABASE_URL")) {
  let failure: string | undefined;
  try {
    const pg = await startEphemeralPostgres();
    if (!pg) failure = "no Postgres binaries found";
    if (pg) {
      setTestDatabaseEnv(pg.url);
      // A preload hook runs once after every test file; the exit handler covers abnormal endings.
      afterAll(() => pg.stop());
      process.on("exit", () => pg.stop());
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          pg.stop();
          process.exit(130);
        });
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.warn(`[testing] could not start a throwaway Postgres: ${failure}`);
  }
  if (failure && inCi) {
    throw new Error(`[testing] CI=true and no database for the database tests (${failure}): set TEST_DATABASE_URL or install Postgres`);
  }
}
