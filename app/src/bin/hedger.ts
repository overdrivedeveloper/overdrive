// Hedger entry point. Boot order: config, hedger settings (dry run by default; mainnet live needs the confirm), distinct
// key, strip other roles' secrets, deployment and node identity, single-instance lock, role check, venues, then the
// cycle loop. It reads the Governor and trades only on venues; it never moves funds off the system.
import { createPublicClient, keccak256, parseAbi, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IODOracleGuardAbi } from "../abi";
import { chainFor } from "../chain/chain";
import { createClients } from "../chain/clients";
import { assertNodeIdentity, loadDeploymentFile } from "../chain/deployment";
import { activeJobs, loadConfig, safeConfigSummary } from "../config";
import { createDbClient } from "../db/client";
import { createSqlHedgerStore } from "../db/queries/hedges";
import { createChainExposureReader, createIndexedReader } from "../hedger/exposure";
import { hedgeMarkets } from "../hedger/markets";
import { runHedgeCycle } from "../hedger/service";
import { assertHedgerKeyDistinct, loadHedgerKey, loadHedgerSettings, stripOtherRoleSecrets } from "../hedger/settings";
import { newHedgerState } from "../hedger/state";
import { ArcusVenue, createLiveArcusPort } from "../hedger/venues/arcus";
import { newPostState, runHedgePosts } from "../hedger/venues/equity";
import { HlHttp, HlSigner, HyperliquidVenue } from "../hedger/venues/hyperliquid";
import { buildVenues, defaultMockVenue } from "../hedger/venues/port";
import { routeFor } from "../hedger/venues/routes";
import { acquireServiceLock } from "../lib/jobs";
import { createLogger, safeErrorSummary } from "../log";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "hedger");
const { sql } = createDbClient(config);
const store = createSqlHedgerStore(sql);

async function fatal(error: unknown): Promise<never> {
  const summary = safeErrorSummary(error);
  logger.error({ err: summary }, "Hedger cannot start");
  await store.writeStatus("hedger", false, {}, summary.message).catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
  process.exit(1);
}

let boot: ReturnType<typeof loadHedgerSettings> | undefined;
let key: `0x${string}` | undefined;
let deployment: ReturnType<typeof loadDeploymentFile> | undefined;
try {
  boot = loadHedgerSettings(config);
  assertHedgerKeyDistinct();
  key = loadHedgerKey();
  if (!key && !boot.settings.dryRun) throw new Error("HEDGER_DRY_RUN=0 needs the hedger key (HEDGER_KEYSTORE + HEDGER_KEYSTORE_PASSWORD_FILE)");
  stripOtherRoleSecrets();
  deployment = loadDeploymentFile(config);
} catch (error) {
  await fatal(error);
}
const { settings, venues: venueNames } = boot!;
const markets = hedgeMarkets(deployment!);
const hedger = key ? privateKeyToAccount(key).address : undefined;
const clients = createClients(config);
try {
  await assertNodeIdentity(
    { chainId: () => clients.stateClient.getChainId(), clientVersion: async () => String(await clients.pool.request("state", { method: "web3_clientVersion" })) },
    config,
  );
} catch (error) {
  await fatal(error);
}
// Reads pinned to one block go one by one (no multicall batching), so exposure and equity share the block exactly.
const reader = createPublicClient({ chain: chainFor(config.CHAIN_ID), transport: clients.pool.transport("state") });
const governor = deployment!.contracts.ODGovernor as `0x${string}`;
const guard = deployment!.contracts.ODOracleGuard as `0x${string}`;

const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
const lock = await acquireServiceLock(config.DATABASE_URL, "hedger", logger, abort.signal);
if (!lock) { await sql.end({ timeout: 2 }); process.exit(0); }

// Role check: the Governor must grant HEDGER_ROLE to this key before any live trade or post. Dry run only warns.
// IODGovernor exposes AccessControl's hasRole; the role id is keccak256("HEDGER_ROLE") (contracts ODRoles.sol).
const ACCESS = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const HEDGER_ROLE = keccak256(stringToHex("HEDGER_ROLE"));
if (hedger) {
  const has = await reader.readContract({ address: governor, abi: ACCESS, functionName: "hasRole", args: [HEDGER_ROLE, hedger] }).catch(() => undefined);
  if (has !== true && !settings.dryRun) await fatal(new Error(`hedger ${hedger} does not hold HEDGER_ROLE on the Governor (or the check failed)`));
  if (has !== true) logger.warn({ hedger }, "Hedger role not confirmed on the Governor; dry run continues");
}

const jobs = activeJobs(config.HEDGER_ENABLED_JOBS, config.HEDGER_DISABLED_JOBS);
let venues;
try {
  const env = boot!.env;
  venues = buildVenues(venueNames, {
    mock: () => defaultMockVenue(markets.map((m) => m.symbol)),
    arcus: () => new ArcusVenue(createLiveArcusPort(deployment!)),
    hyperliquid: () => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(env.HL_ACCOUNT_ADDRESS)) throw new Error("HEDGER_VENUES includes hyperliquid but HL_ACCOUNT_ADDRESS is not set");
      return new HyperliquidVenue({
        http: new HlHttp({ baseUrl: env.HL_API_URL }), network: env.HL_NETWORK, account: env.HL_ACCOUNT_ADDRESS as `0x${string}`,
        symbols: markets.map((m) => m.symbol), ...(key && !settings.dryRun ? { signer: new HlSigner(key, env.HL_NETWORK) } : {}),
      });
    },
  });
  if (!settings.dryRun && jobs.includes("post")) throw new Error("live hedge posting needs the transaction queue (todo 14); run with HEDGER_DRY_RUN=1 until it lands");
} catch (error) {
  await lock.release();
  await fatal(error);
}

const state = newHedgerState();
const deps = {
  markets, venues: venues!, store, settings, state, logger, now: () => Date.now(), routeFor,
  chain: createChainExposureReader(reader, governor),
  indexed: createIndexedReader(sql),
  async markAgeMs(m: { market: `0x${string}` }) {
    const read = await reader.readContract({ address: guard, abi: IODOracleGuardAbi, functionName: "read", args: [m.market] });
    if (!read.fresh) return Number.POSITIVE_INFINITY;
    return Date.now() - Number(read.updatedAt) * 1000;
  },
};
await store.writeStatus("hedger", true, { booted: new Date().toISOString(), config: safeConfigSummary(config), dryRun: settings.dryRun, venues: venueNames, jobs, markets: markets.map((m) => m.symbol) });
logger.info({ config: safeConfigSummary(config), dryRun: settings.dryRun, venues: venueNames, jobs, markets: markets.length }, "Hedger started");

// The Governor's hedge bounds (hedgeMaxAge, maxHedgeJumpBps) are not in the IODGovernor interface yet (todo 05a); the
// getters below are tried and an unreadable config fails closed (nothing is posted, the miss is reported).
const BOUNDS = parseAbi(["function hedgeMaxAge() view returns (uint64)", "function maxHedgeJumpBps() view returns (uint16)"]);
const postState = newPostState();
const postDeps = {
  markets, venues: venues!, store, logger, now: () => Date.now(), dryRun: settings.dryRun, state: postState,
  chainTimeS: async () => Number((await reader.getBlock({ blockTag: "latest" })).timestamp),
  governorConfig: async () => {
    const [age, jump] = await Promise.all([
      reader.readContract({ address: governor, abi: BOUNDS, functionName: "hedgeMaxAge" }),
      reader.readContract({ address: governor, abi: BOUNDS, functionName: "maxHedgeJumpBps" }),
    ]);
    return { hedgeMaxAgeS: Number(age), maxHedgeJumpBps: Number(jump) };
  },
  postHedge: async () => { throw new Error("live hedge posting needs the transaction queue (todo 14)"); },
};

while (!abort.signal.aborted) {
  if ((await lock.check()) === "lost") { logger.error("Single-instance lock lost; stopping"); break; }
  if (jobs.includes("cycle")) {
    try {
      const r = await runHedgeCycle(deps);
      logger.info({ names: Object.keys(r.names).length, unhedged: Object.keys(r.unhedged).length, venueHealthy: r.venueHealthy }, "Hedge cycle done");
      if (jobs.includes("post")) {
        const traded = new Set(Object.values(r.names).filter((n) => n.action === "traded").map((n) => n.underlying));
        const posts = await runHedgePosts(postDeps, traded);
        await store.writeStatus("hedger", true, { posts: Object.fromEntries(Object.entries(posts).map(([k, v]) => [k, { action: v.action, reason: v.reason ?? null, timeLeftS: v.timeLeftS ?? null }])) });
      }
    } catch (error) {
      logger.error({ err: safeErrorSummary(error) }, "Hedge cycle failed");
      await store.writeStatus("hedger", false, {}, safeErrorSummary(error).message).catch(() => undefined);
    }
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, settings.cycleSeconds * 1000);
    abort.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
await lock.release();
await sql.end({ timeout: 5 });
process.exit(0);
