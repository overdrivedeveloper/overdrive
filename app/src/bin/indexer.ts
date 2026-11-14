// Indexer entry point. Reads logs, writes rows, never signs or sends a transaction and never pauses anything.
import { assertNodeIdentity, loadDeploymentFile } from "../chain/deployment";
import { createClients } from "../chain/clients";
import { assertKeysSeparated, loadConfig, safeConfigSummary } from "../config";
import { createDbClient } from "../db/client";
import { createRpcChainSource } from "../indexer/chain-source";
import { createChainReader } from "../indexer/chain-reader";
import { createIndexerState, createIngest, ReorgTooDeepError } from "../indexer/ingest";
import { createLogger, safeErrorSummary } from "../log";
import { sleepUnlessAborted } from "../lib/abort";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "indexer");
assertKeysSeparated();
const { sql } = createDbClient(config);

async function fatal(error: unknown): Promise<never> {
  const summary = safeErrorSummary(error);
  logger.error({ err: summary }, "Indexer cannot start");
  await sql`INSERT INTO service_status (job, last_run, last_error) VALUES ('indexer', NOW(), ${summary.message})
    ON CONFLICT (job) DO UPDATE SET last_run = NOW(), last_error = EXCLUDED.last_error`.catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
  process.exit(1);
}

let loaded: ReturnType<typeof loadDeploymentFile> | undefined;
try { loaded = loadDeploymentFile(config); } catch (error) { await fatal(error); }
const deployment = loaded!;
const clients = createClients(config);
try {
  await assertNodeIdentity(
    {
      chainId: () => clients.logsClient.getChainId(),
      clientVersion: async () => String(await clients.pool.request("state", { method: "web3_clientVersion" })),
    },
    config,
  );
} catch (error) {
  await fatal(error);
}

const state = await createIndexerState({
  settings: { confirmations: config.INDEXER_CONFIRMATIONS, catchupConcurrency: config.INDEXER_CATCHUP_CONCURRENCY, snapshotHeartbeatMs: config.INDEXER_SNAPSHOT_HEARTBEAT_MS },
  source: createRpcChainSource(clients),
  reader: createChainReader(clients, deployment),
  sql,
  logger,
  deployment,
});
await sql`INSERT INTO service_status (job, last_run, last_ok, last_error, meta) VALUES ('indexer', NOW(), NOW(), NULL, ${JSON.stringify({ booted: new Date().toISOString(), config: safeConfigSummary(config) })}::jsonb)
  ON CONFLICT (job) DO UPDATE SET last_run = NOW(), last_ok = NOW(), last_error = NULL, meta = service_status.meta || EXCLUDED.meta`;
logger.info({ config: safeConfigSummary(config), cursor: state.cursor.toString() }, "Indexer started");

const ingest = createIngest(state);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
let failures = 0;
while (!abort.signal.aborted) {
  let delay = config.INDEXER_POLL_BASE_MS;
  try {
    const result = await ingest.tick();
    failures = 0;
    delay = result.ingested > 0n ? config.INDEXER_POLL_ACTIVE_MS : config.INDEXER_POLL_BASE_MS;
    if (result.ingested > 0n && result.head - state.cursor > 100n) delay = 0; // still catching up
  } catch (error) {
    failures += 1;
    const summary = safeErrorSummary(error);
    logger.error({ err: summary, failures }, "Indexer tick failed");
    await sql`INSERT INTO service_status (job, last_run, last_error) VALUES ('indexer', NOW(), ${summary.message})
      ON CONFLICT (job) DO UPDATE SET last_run = NOW(), last_error = EXCLUDED.last_error`.catch(() => undefined);
    if (error instanceof ReorgTooDeepError) break; // never silently skip; an operator re-indexes
    delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4));
  }
  await sleepUnlessAborted(delay, abort.signal);
}
await sql.end({ timeout: 5 });
process.exit(abort.signal.aborted ? 0 : 1);
