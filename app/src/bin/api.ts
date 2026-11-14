// API entry point. Read only: it reads Postgres through a SELECT-only role and the chain through the state client,
// holds no key and sends nothing.
import { assertNodeIdentity, loadDeploymentFile } from "../chain/deployment";
import { createClients } from "../chain/clients";
import { assertKeysSeparated, loadConfig, safeConfigSummary } from "../config";
import { createApiSql } from "../db/client";
import { assertReadOnlyRole } from "../db/readonly";
import { createLogger, safeErrorSummary } from "../log";
import { createApiApp } from "../api/app";
import { TtlCache } from "../api/cache";
import { createApiChain } from "../api/chain-reads";
import { mockHookFor } from "../testing/mock-hook";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "api");

function fatal(error: unknown): never {
  logger.error({ err: safeErrorSummary(error) }, "API cannot start");
  process.exit(1);
}

try {
  assertKeysSeparated();
  if (config.API_QUOTER === "mock" && config.NETWORK !== "fork") throw new Error("API_QUOTER=mock is only allowed with NETWORK=fork");
  const url = config.API_DB_READONLY_URL || (config.NODE_ENV === "production" ? "" : config.DATABASE_URL);
  if (!url) throw new Error("API_DB_READONLY_URL is required in production (a SELECT-only role)");
  const deployment = loadDeploymentFile(config);
  const sql = createApiSql(url);
  await assertReadOnlyRole(sql);
  let chain;
  if (config.API_QUOTER === "mock") {
    chain = mockHookFor(deployment).asChain();
    logger.warn("API_QUOTER=mock: quotes come from the in-process mock hook (fork only)");
  } else {
    const clients = createClients(config);
    await assertNodeIdentity({ chainId: () => clients.stateClient.getChainId(), clientVersion: async () => String(await clients.pool.request("state", { method: "web3_clientVersion" })) }, config);
    chain = createApiChain(clients.stateClient, deployment, config.QUOTER_ADDRESS || undefined);
  }
  const app = createApiApp({ sql, config, deployment, logger, cache: new TtlCache(), chain });
  const server = Bun.serve({ port: config.API_PORT, fetch: app.fetch });
  logger.info({ config: safeConfigSummary(config), port: server.port }, "API started");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.stop(); void sql.end({ timeout: 2 }).finally(() => process.exit(0)); });
} catch (error) {
  fatal(error);
}
