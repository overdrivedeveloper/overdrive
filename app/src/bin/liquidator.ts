// Liquidator entry point: the paid backstop that seals and executes backer liquidation batches. Both calls are permissionless; the
// key holds gas ETH only. `bun run src/bin/liquidator.ts [--once]`; LIQUIDATOR_DRY_RUN=1 (the default) simulates and sends nothing.
import { bootLiquidator } from "../liquidator";
import { logger, safeErrorSummary } from "../log";

const once = process.argv.includes("--once");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());

try {
  const handle = await bootLiquidator(process.env, { once, signal: abort.signal });
  logger.info({ backer: handle.backer, dryRun: handle.settings.dryRun }, "Liquidator ready");
  if (once) console.log(JSON.stringify(handle.results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  await handle.done;
  await handle.stop();
  logger.info("Liquidator stopped");
} catch (error) {
  logger.error({ err: safeErrorSummary(error) }, "Liquidator cannot start");
  process.exitCode = 1;
}
