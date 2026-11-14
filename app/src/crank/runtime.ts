// Boot and wiring of the crank. `bin/crank.ts` builds the real dependencies; tests pass fakes. Jobs run on 13's scheduler: a job
// that throws is retried with backoff and never stops the others (R20); one instance signs at a time (R2).
import { CRANK_JOBS, activeJobs, assertKeysSeparated, loadConfig, safeConfigSummary, type RuntimeConfig, type CrankJob } from "../config";
import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { Deployment } from "../chain/deployment";
import type { ServiceClients } from "../chain/clients";
import { acquireServiceLock, createScheduler, type ServiceJob, type ServiceLock } from "../lib/jobs";
import { createClients } from "../chain/clients";
import { assertNodeIdentity, loadDeploymentFile } from "../chain/deployment";
import { createDbClient } from "../db/client";
import { KEY_ROLES, resolveKey } from "../keys";
import { createLogger } from "../log";
import { safeErrorSummary } from "../log";
import { chainClock, readIndexerMetadata, type CrankContext } from "./context";
import { checkRoles, requiredRoles } from "./startup";
import { computeSessions } from "./sessions";
import { createTxQueue, withPriority, type TxQueue } from "./tx";
import { createHeartbeatJob } from "./jobs/heartbeat";
import { createPokeJob } from "./jobs/poke";
import { createSessionsJob } from "./jobs/sessions";
import { createTollJob } from "./jobs/toll";
import { createVolWatchJob } from "./jobs/vol-watch";
import { createAdminWatchJob } from "./jobs/admin-watch";
import { createFeesJob } from "./jobs/fees";
import { createGasWatchJob } from "./jobs/gas-watch";
import { createQueuedSellsJob } from "./jobs/queued-sells";
import { createRiskMonitorJob } from "./jobs/risk-monitor";
import { setAlertSender } from "./alerts";
import { createTelegramSender } from "./telegram";
import { onAbort } from "../lib/abort";

export { CRANK_JOBS };
export type { CrankContext, ServiceJob };

/** Jobs in the order they matter (KEEP-4): protocol work first, then user-triggered work, then watchers. */
export const JOB_TIERS: Record<CrankJob, "protocol" | "user" | "watch"> = {
  sessions: "protocol", toll: "protocol", poke: "protocol", fees: "protocol",
  "queued-sells": "user",
  "vol-watch": "watch", "risk-monitor": "watch", "admin-watch": "watch", "gas-watch": "watch", heartbeat: "watch",
};

/** Validates job names from the raw environment BEFORE any connection is made (R1). Returns the active jobs. */
export function resolveCrankJobs(env: Record<string, string | undefined>): CrankJob[] {
  const names = (value: string | undefined, fallback: string): string[] => {
    const text = value === undefined ? fallback : value;
    if (text.trim() === "") return [];
    return text.split(",").map((n) => n.trim());
  };
  const enabled = names(env.CRANK_ENABLED_JOBS, CRANK_JOBS.join(","));
  const disabled = names(env.CRANK_DISABLED_JOBS, "");
  for (const name of [...enabled, ...disabled]) if (!(CRANK_JOBS as readonly string[]).includes(name)) throw new Error(`Unknown job: ${name}`);
  return activeJobs(enabled as CrankJob[], disabled as CrankJob[]);
}

export interface JobFactoryOptions {
  heartbeatFile: string;
  lock?: Pick<ServiceLock, "check"> | undefined;
  onLockLost: () => void;
}
export type JobFactory = (ctx: CrankContext, options: JobFactoryOptions, hooks: CrankHooks) => ServiceJob;

/** What the boundary timers trigger: a forced toll pass and a forced poke. */
export interface CrankHooks { forceToll: boolean; forcePoke: boolean }

/** Job definitions: one factory per name in CRANK_JOBS. */
export const JOB_FACTORIES: Partial<Record<CrankJob, JobFactory>> = {
  sessions: (ctx) => ({ name: "sessions", everyMs: 3_600_000, run: createSessionsJob(ctx) }),
  toll: (ctx, _o, hooks) => {
    const toll = createTollJob(ctx);
    return { name: "toll", everyMs: 300_000, run: async () => {
      const force = hooks.forceToll;
      hooks.forceToll = false;
      try { return await toll(force); } catch (error) { hooks.forceToll ||= force; throw error; }
    } };
  },
  poke: (ctx, _o, hooks) => {
    const poke = createPokeJob(ctx);
    return { name: "poke", everyMs: 60_000, run: async () => { const force = hooks.forcePoke; hooks.forcePoke = false; return poke(force); } };
  },
  "vol-watch": (ctx) => ({ name: "vol-watch", everyMs: 60_000, run: createVolWatchJob(ctx) }),
  fees: (ctx) => ({ name: "fees", everyMs: 3_600_000, run: createFeesJob(ctx) }),
  "queued-sells": (ctx) => ({ name: "queued-sells", everyMs: 120_000, run: createQueuedSellsJob(ctx) }),
  "risk-monitor": (ctx) => ({ name: "risk-monitor", everyMs: 60_000, run: createRiskMonitorJob(ctx) }),
  "admin-watch": (ctx) => ({ name: "admin-watch", everyMs: 60_000, run: createAdminWatchJob(ctx) }),
  "gas-watch": (ctx) => ({ name: "gas-watch", everyMs: 600_000, run: createGasWatchJob(ctx) }),
  heartbeat: (ctx, options) => ({ name: "heartbeat", everyMs: 30_000, run: createHeartbeatJob(ctx, { file: options.heartbeatFile, lock: options.lock, onLockLost: options.onLockLost }) }),
};

export function buildJobs(ctx: CrankContext, enabled: readonly CrankJob[], options: JobFactoryOptions, hooks: CrankHooks): ServiceJob[] {
  const jobs: ServiceJob[] = [];
  for (const name of CRANK_JOBS) {
    if (!enabled.includes(name)) continue;
    const factory = JOB_FACTORIES[name];
    if (!factory) { ctx.logger.warn({ job: name }, "Crank job has no implementation in this build; skipped"); continue; }
    const tier = JOB_TIERS[name];
    // User-triggered work waits behind protocol transactions for the one nonce (R9).
    const scoped = tier === "user" ? { ...ctx, tx: withPriority(ctx.tx, "user") } : ctx;
    jobs.push({ jitterMs: 2000, ...factory(scoped, options, hooks) });
  }
  return jobs;
}

export interface CrankDeps {
  config: RuntimeConfig;
  logger: Logger;
  sql: Sql;
  clients: ServiceClients;
  deployment: Deployment;
  tx?: TxQueue;
  lock?: ServiceLock | undefined;
  heartbeatFile?: string;
  /** Run every enabled job once, in tier order, and return (the boot test and `bin/crank.ts --once`). */
  once?: boolean;
  signal?: AbortSignal;
  onExit?: (code: number) => void;
  /** Overrides for tests. */
  now?: () => Date;
}

export interface CrankHandle {
  jobs: string[];
  results: Record<string, Record<string, unknown> | { error: string } | undefined>;
  stop(): Promise<void>;
  /** Resolves when the crank stops (abort, lost lock) or after the single pass in `once` mode. */
  done: Promise<void>;
  exitCode: number;
}

const BOUNDARY_LEAD_SECONDS = 30;

/** Role checks (R22): a missing role refuses to start unless dry run. */
export async function assertRoles(deps: Pick<CrankDeps, "config" | "clients" | "deployment" | "logger">, enabled: ReadonlySet<string>): Promise<void> {
  const account = deps.clients.walletClient?.account;
  const sends = ["sessions", "toll", "poke", "fees", "queued-sells", "risk-monitor"].some((job) => enabled.has(job));
  if (!sends) return;
  if (!account) throw new Error("No crank signer configured (CRANK_KEYSTORE and CRANK_KEYSTORE_PASSWORD_FILE)");
  const roles = await checkRoles(deps.clients, requiredRoles(enabled, deps.deployment, { autopause: deps.config.CRANK_AUTOPAUSE }), account.address);
  for (const need of roles.unverified) deps.logger.warn({ job: need.job, contract: need.contract, role: need.role }, "Could not verify crank role");
  if (roles.missing.length && !deps.config.CRANK_DRY_RUN) {
    throw new Error(`Crank lacks required roles: ${roles.missing.map((n) => `${n.job}:${n.contract}.${n.role}`).join(", ")}`);
  }
  for (const need of roles.missing) deps.logger.warn({ job: need.job, contract: need.contract, role: need.role }, "Crank lacks a role (dry run continues)");
}

export async function startCrank(deps: CrankDeps): Promise<CrankHandle> {
  const { config, logger, sql, clients, deployment } = deps;
  const enabledList = resolveCrankJobs({ CRANK_ENABLED_JOBS: config.CRANK_ENABLED_JOBS.join(","), CRANK_DISABLED_JOBS: config.CRANK_DISABLED_JOBS.join(",") });
  const enabled = new Set<string>(enabledList);
  await assertRoles(deps, enabled);
  const tx = deps.tx ?? createTxQueue(clients, {
    dryRun: config.CRANK_DRY_RUN, logger,
    gasLimit: { multiplierBps: config.CRANK_GAS_MULTIPLIER_BPS, headroom: BigInt(config.CRANK_GAS_HEADROOM), cap: BigInt(config.CRANK_GAS_CAP) },
    onHash: async (transaction, hash) => {
      const job = transaction.label.split(":")[0]!;
      await sql`insert into service_status (job, last_tx) values (${job}, ${hash}) on conflict (job) do update set last_tx = excluded.last_tx`;
    },
  });
  const ctx: CrankContext = {
    sql, clients, deployment, config, logger, tx,
    metadata: () => readIndexerMetadata(sql), now: (meta) => (deps.now ? deps.now() : chainClock(config, meta)),
  };
  logger.info({ config: safeConfigSummary(config), signer: clients.walletClient?.account?.address, dryRun: config.CRANK_DRY_RUN, jobs: enabledList }, "Crank starting");

  let exitCode = 0;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const scheduler = createScheduler(sql, logger);
  const hooks: CrankHooks = { forceToll: false, forcePoke: false };
  const onLockLost = () => { exitCode = 1; handle.exitCode = 1; deps.onExit?.(1); finish(); };
  const jobs = buildJobs(ctx, enabledList, { heartbeatFile: deps.heartbeatFile ?? "/tmp/heartbeat", lock: deps.lock, onLockLost }, hooks);
  const handle: CrankHandle = { jobs: jobs.map((j) => j.name), results: {}, exitCode, done, stop: async () => undefined };

  // Boundary timers (R5, R14): a forced toll accrual 30 s before and after each session edge, a poke right after it.
  const timers: ReturnType<typeof setTimeout>[] = [];
  const fired = new Set<string>();
  const armBoundaries = async () => {
    for (const t of timers.splice(0)) clearTimeout(t);
    const nowMs = ctx.now(await ctx.metadata()).getTime();
    const wallNow = Date.now();
    const edges = computeSessions(new Date(nowMs - 120_000), "us_equity", 3).flatMap((s) => [s.open, s.close]);
    for (const edge of edges) for (const offset of [-BOUNDARY_LEAD_SECONDS, BOUNDARY_LEAD_SECONDS]) {
      const key = `${edge}:${offset}`;
      const delay = (Number(edge) + offset) * 1000 - nowMs;
      if (delay < -90_000 || delay > 2_147_483_647 || fired.has(key)) continue;
      timers.push(setTimeout(() => {
        fired.add(key);
        hooks.forceToll = true;
        if (offset > 0) hooks.forcePoke = true;
        const late = (Date.now() - (wallNow + delay)) / 1000;
        if (late > 5) logger.warn({ key, lateSeconds: late }, "Crank boundary accrual is late");
        void scheduler.trigger("toll");
        if (offset > 0) void scheduler.trigger("poke");
      }, Math.max(0, delay)));
    }
  };
  if (!deps.once && (enabled.has("toll") || enabled.has("poke"))) {
    try { await armBoundaries(); } catch (error) { logger.warn({ err: safeErrorSummary(error) }, "Could not arm session boundary timers"); }
  }
  let rearm: ReturnType<typeof setInterval> | undefined;

  if (deps.once) {
    // One pass of every enabled job, protocol tier first.
    for (const job of [...jobs].sort((a, b) => ["protocol", "user", "watch"].indexOf(JOB_TIERS[a.name as CrankJob]) - ["protocol", "user", "watch"].indexOf(JOB_TIERS[b.name as CrankJob]))) {
      try { handle.results[job.name] = (await job.run()) ?? {}; }
      catch (error) { handle.results[job.name] = { error: safeErrorSummary(error).message }; }
    }
    finish();
  } else {
    for (const job of jobs) scheduler.add(job);
    rearm = setInterval(() => { void armBoundaries().catch(() => undefined); }, 3_600_000);
    onAbort(deps.signal, () => finish());
  }

  handle.stop = async () => {
    if (rearm) clearInterval(rearm);
    for (const t of timers.splice(0)) clearTimeout(t);
    await scheduler.stop();
    await tx.drain();
    finish();
  };
  return handle;
}


// ---------------------------------------------------------------------------------------------------------- boot
export interface BootOptions {
  once?: boolean;
  signal?: AbortSignal;
  onExit?: (code: number) => void;
  heartbeatFile?: string;
  /** Test seams: the real boot builds all of these from the environment. */
  makeClients?: (config: RuntimeConfig, key: `0x${string}` | undefined) => ServiceClients;
  sql?: Sql;
  now?: () => Date;
  skipNodeIdentity?: boolean;
}

/** The production boot sequence (R1, R2, R22): validate job names, load config and the signing key, check the deployment and
 * the node, take the single-instance lock, check roles, start the jobs. Nothing connects before the job names pass. */
export async function bootCrank(env: Record<string, string | undefined>, options: BootOptions = {}): Promise<CrankHandle & { config: RuntimeConfig }> {
  resolveCrankJobs(env);
  const config = loadConfig(env);
  const logger = createLogger(config.LOG_LEVEL, "crank");
  assertKeysSeparated(env);
  const key = resolveKey(KEY_ROLES.crank, env);
  const deployment = loadDeploymentFile(config);
  const clients = options.makeClients ? options.makeClients(config, key) : createClients(config, undefined, key);
  if (!options.skipNodeIdentity) {
    await assertNodeIdentity({
      chainId: () => clients.txClient.getChainId(),
      clientVersion: async () => String(await clients.pool.request("state", { method: "web3_clientVersion" })),
    }, config);
  }
  const sql = options.sql ?? createDbClient(config).sql;
  if (config.TELEGRAM_ENV_FILE) setAlertSender(createTelegramSender(config.TELEGRAM_ENV_FILE, config.TELEGRAM_API_BASE));
  const abort = new AbortController();
  const signal = options.signal;
  onAbort(signal, () => abort.abort());
  const lock = await acquireServiceLock(config.DATABASE_URL, "crank", logger, abort.signal);
  if (!lock) throw new Error("Crank stopped before it took the single-instance lock");
  let handle: CrankHandle;
  try {
    handle = await startCrank({
      config, logger, sql, clients, deployment, lock, once: options.once ?? false, signal: abort.signal,
      ...(options.heartbeatFile ? { heartbeatFile: options.heartbeatFile } : {}),
      ...(options.onExit ? { onExit: options.onExit } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    await lock.release();
    if (!options.sql) await sql.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
  const stop = handle.stop;
  handle.stop = async () => { await stop(); await lock.release(); if (!options.sql) await sql.end({ timeout: 5 }).catch(() => undefined); };
  return Object.assign(handle, { config });
}
