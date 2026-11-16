import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionalEnv, setTestDatabaseEnv, setTestForkDir } from "../config";
import { startEphemeralPostgres } from "./pg";

// `bun test` preload: give the database tests a throwaway Postgres unless the caller supplied one.
// Locally the database tests skip when no Postgres is installed. In CI (CI=true) a missing database fails the run
// instead, so a green CI always includes the database tests.
// CI is not a service variable, so it is read here directly rather than through config.ts.
const inCi = optionalEnv("CI")?.trim() === "true";

// Unit tests never touch a real fork stack. app/scripts/fork/lib.ts reads FORK_DIR once, when it is first imported, and any
// test file may import it first: bun runs every file in one process, in directory order, which differs between macOS
// and Linux (on GitHub report.test.ts loaded lib.ts before fork.test.ts set FORK_DIR, so fork.test.ts read
// ~/.overdrive/fork). Point FORK_DIR at a temp dir before any test file loads; FORK_LIVE=1 keeps the caller's.
const forkDir = setTestForkDir(() => mkdtempSync(join(tmpdir(), "od-fork-test-")));
if (forkDir) process.on("exit", () => rmSync(forkDir, { recursive: true, force: true }));
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
