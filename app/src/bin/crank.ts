// Crank entry point: the paid, scheduled caller of every lever (toll, sessions, poke, fees, queue, watchers). Never holds a
// guardian or owner key. `bun run src/bin/crank.ts [--once]`; with CRANK_DRY_RUN=1 every job simulates and sends nothing.
import { bootCrank } from "../crank/runtime";
import { safeErrorSummary, logger } from "../log";

const once = process.argv.includes("--once");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());

try {
  const handle = await bootCrank(process.env, { once, signal: abort.signal, onExit: (code) => { process.exitCode = code; abort.abort(); } });
  logger.info({ jobs: handle.jobs }, "Crank ready");
  if (once) console.log(JSON.stringify(handle.results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  await handle.done;
  await handle.stop();
  logger.info("Crank stopped");
} catch (error) {
  logger.error({ err: safeErrorSummary(error) }, "Crank cannot start");
  process.exitCode = 1;
}
