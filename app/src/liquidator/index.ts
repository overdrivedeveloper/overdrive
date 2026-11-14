// Boot and wiring of the liquidator (R12, R13, R15). Order, as in the crank: job names, config and settings, distinct keys, the
// signing key, the deployment file, the node, the single-instance lock, then the pass on the shared scheduler and tx queue.
import type { Logger } from "pino";
import type { Sql } from "postgres";
import { assertKeysSeparated, loadConfig, safeConfigSummary, type RuntimeConfig } from "../config";
import { createClients, type ServiceClients } from "../chain/clients";
import { assertNodeIdentity, loadDeploymentFile, type Deployment } from "../chain/deployment";
import { createTxQueue, type TxQueue } from "../crank/tx";
import { createDbClient } from "../db/client";
import { KEY_ROLES, resolveKey } from "../keys";
import { acquireServiceLock, createScheduler, type ServiceLock } from "../lib/jobs";
import { createLogger, safeErrorSummary } from "../log";
import { liquidatorAddresses } from "./batch";
import { LIQUIDATOR_STATUS_JOB, runLiquidationPass, type PassResult } from "./service";
import { loadLiquidatorSettings, type LiquidatorSettings } from "./settings";
import { LiquidatorState } from "./state";

export { runLiquidationPass, type PassDeps, type PassResult } from "./service";
export { LiquidatorState } from "./state";
export { loadLiquidatorSettings, type LiquidatorSettings } from "./settings";

export interface LiquidatorHandle {
  config: RuntimeConfig;
  settings: LiquidatorSettings;
  backer: string;
  results: PassResult[];
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface LiquidatorBootOptions {
  once?: boolean;
  signal?: AbortSignal;
  /** Test seams: the real boot builds these from the environment. */
  makeClients?: (config: RuntimeConfig, key: `0x${string}` | undefined) => ServiceClients;
  sql?: Sql;
  tx?: TxQueue;
  skipNodeIdentity?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function bootLiquidator(env: Record<string, string | undefined>, options: LiquidatorBootOptions = {}): Promise<LiquidatorHandle> {
  const config = loadConfig(env);
  const settings = loadLiquidatorSettings(env, config);
  const logger: Logger = createLogger(config.LOG_LEVEL, "liquidator");
  assertKeysSeparated(env);
  const key = resolveKey(KEY_ROLES.liquidator, env);
  if (!key) throw new Error("No liquidator signer configured (LIQUIDATOR_KEYSTORE and LIQUIDATOR_KEYSTORE_PASSWORD_FILE)");
  const deployment: Deployment = loadDeploymentFile(config);
  const addresses = liquidatorAddresses(deployment.contracts);
  const clients = options.makeClients ? options.makeClients(config, key) : createClients(config, undefined, key);
  if (!options.skipNodeIdentity) {
    await assertNodeIdentity({
      chainId: () => clients.txClient.getChainId(),
      clientVersion: async () => String(await clients.pool.request("state", { method: "web3_clientVersion" })),
    }, config);
  }
  const sql = options.sql ?? createDbClient(config).sql;
  const abort = new AbortController();
  options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const lock: ServiceLock | undefined = await acquireServiceLock(config.DATABASE_URL, "liquidator", logger, abort.signal);
  if (!lock) throw new Error("Liquidator stopped before it took the single-instance lock");

  const tx = options.tx ?? createTxQueue(clients, {
    dryRun: settings.dryRun, logger,
    onHash: async (_t, hash) => {
      await sql`insert into service_status (job, last_tx) values (${LIQUIDATOR_STATUS_JOB}, ${hash}) on conflict (job) do update set last_tx = excluded.last_tx`;
    },
  });
  const state = new LiquidatorState();
  const account = clients.walletClient?.account?.address;
  logger.info({ config: safeConfigSummary(config), backer: addresses.backer, signer: account, dryRun: settings.dryRun, jobs: [...settings.jobs] }, "Liquidator starting");

  const results: PassResult[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const pass = async (): Promise<PassResult> => {
    // Only the session holding the lock may sign (R13).
    if ((await lock.check()) === "lost") { logger.error("Liquidator lost its single-instance lock; stopping"); abort.abort(); finish(); throw new Error("lock lost"); }
    const result = await runLiquidationPass({
      sql, clients, deployment, settings, tx, logger, state, ...(account ? { account } : {}), ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    results.push(result);
    return result;
  };

  const scheduler = createScheduler(sql, logger);
  const cleanup = async () => {
    await scheduler.stop();
    await tx.drain();
    await lock.release();
    if (!options.sql) await sql.end({ timeout: 5 }).catch(() => undefined);
  };
  if (options.once) {
    try { await pass(); } catch (error) { await cleanup(); throw error; }
    finish();
  } else {
    scheduler.add({
      name: `${LIQUIDATOR_STATUS_JOB}-pass`, everyMs: settings.passSeconds * 1000, jitterMs: 1000,
      run: async () => {
        const r = await pass();
        return { ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), liquidatable: r.liquidatable, openBatches: r.openBatches };
      },
    });
    abort.signal.addEventListener("abort", () => finish(), { once: true });
  }
  let stopped = false;
  return {
    config, settings, backer: addresses.backer, results, done,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try { await cleanup(); } catch (error) { logger.warn({ err: safeErrorSummary(error) }, "Liquidator stop failed"); }
      finish();
    },
  };
}
