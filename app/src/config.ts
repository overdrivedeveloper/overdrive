import { z } from "zod";
import { KeyConfigError, assertDistinctKeys } from "./keys";

/** Valid job names, one exported const per service. Config validation imports them, so an unknown name fails at boot. */
export const CRANK_JOBS = ["sessions", "toll", "poke", "vol-watch", "queued-sells", "fees", "risk-monitor", "admin-watch", "gas-watch", "heartbeat"] as const;
export const HEDGER_JOBS = ["cycle", "post", "reconcile"] as const;
export const LIQUIDATOR_JOBS = ["scan", "seal", "execute", "watch"] as const;
export type CrankJob = (typeof CRANK_JOBS)[number];
export type HedgerJob = (typeof HEDGER_JOBS)[number];
export type LiquidatorJob = (typeof LIQUIDATOR_JOBS)[number];

export const NETWORK_CHAIN_IDS = { mainnet: 4663, testnet: 46630, fork: 31337 } as const;

const routeSchema = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()))
    .pipe(z.array(z.enum(["public", "alchemy"])).min(1));

const boolFlag = (fallback: "0" | "1") =>
  z.enum(["0", "1", "true", "false"]).default(fallback).transform((value) => value === "1" || value === "true");

const addressOrEmpty = z.string().regex(/^(0x[0-9a-fA-F]{40})?$/).default("");

/** A job list: csv, entries trimmed. An empty entry (for example "a,,b") or an unknown name throws `Unknown job: <name>`. */
function jobList<const T extends readonly string[]>(valid: T, fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((value, ctx): T[number][] => {
      if (value.trim() === "") return [];
      const out: T[number][] = [];
      for (const raw of value.split(",")) {
        const name = raw.trim();
        if (!(valid as readonly string[]).includes(name)) {
          ctx.addIssue({ code: "custom", message: `Unknown job: ${name}` });
          return z.NEVER;
        }
        out.push(name);
      }
      return out;
    });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  NETWORK: z.enum(["mainnet", "fork", "testnet"]).default("fork"),
  CHAIN_ID: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().url(),
  PUBLIC_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  RPC_URL_OVERRIDE: z.string().default(""),
  RPC_BACKUP_URL: z.union([z.literal(""), z.string().url()]).optional(),
  ALCHEMY_API_KEYS: z.string().default(""),
  ALCHEMY_URL_TEMPLATE: z.string().default("https://robinhood-mainnet.g.alchemy.com/v2/{key}"),
  RPC_ROUTE_LOGS: routeSchema("public,alchemy"),
  RPC_ROUTE_STATE: routeSchema("public,alchemy"),
  RPC_ROUTE_TX: routeSchema("alchemy,public"),
  DEPLOYMENT_FILE: z.string().min(1).default("deployments/anvil.json"),
  INDEXER_POLL_ACTIVE_MS: z.coerce.number().int().positive().default(5000),
  INDEXER_POLL_BASE_MS: z.coerce.number().int().positive().default(15000),
  INDEXER_POLL_IDLE_MS: z.coerce.number().int().positive().default(60000),
  INDEXER_CATCHUP_CONCURRENCY: z.coerce.number().int().min(1).max(6).default(3),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).max(64).optional(),
  INDEXER_SNAPSHOT_HEARTBEAT_MS: z.coerce.number().int().min(5000).max(600_000).default(600_000),
  CRANK_ENABLED_JOBS: jobList(CRANK_JOBS, CRANK_JOBS.join(",")),
  CRANK_DISABLED_JOBS: jobList(CRANK_JOBS, ""),
  HEDGER_ENABLED_JOBS: jobList(HEDGER_JOBS, HEDGER_JOBS.join(",")),
  HEDGER_DISABLED_JOBS: jobList(HEDGER_JOBS, ""),
  LIQUIDATOR_ENABLED_JOBS: jobList(LIQUIDATOR_JOBS, LIQUIDATOR_JOBS.join(",")),
  LIQUIDATOR_DISABLED_JOBS: jobList(LIQUIDATOR_JOBS, ""),
  CRANK_DRY_RUN: boolFlag("0"),
  CRANK_AUTOPAUSE: boolFlag("0"),
  CRANK_GAS_MULTIPLIER_BPS: z.coerce.number().int().min(12_000).max(100_000).default(15_000),
  CRANK_GAS_HEADROOM: z.coerce.number().int().min(0).default(500_000),
  CRANK_GAS_CAP: z.coerce.number().int().positive().default(32_000_000),
  CRANK_TOLL_MAX_AGE_SECONDS: z.coerce.number().int().min(300).default(3600),
  CRANK_TOLL_BATCH: z.coerce.number().int().min(1).max(45).default(40),
  CRANK_TOLL_BATCH_MAX: z.coerce.number().int().min(1).max(45).default(45),
  CRANK_TOLL_GAS_TARGET: z.coerce.number().int().positive().default(8_000_000),
  CRANK_QUEUE_MAX_PER_PASS: z.coerce.number().int().min(1).default(25),
  CRANK_QUEUE_RETRY_MS: z.coerce.number().int().min(1000).default(600_000),
  VOL_STALE_WARN_SECONDS: z.coerce.number().int().min(60).default(900),
  FEES_MIN_USDG: z.coerce.number().min(0).default(50),
  GAS_WATCH_MIN_ETH_CRANK: z.coerce.number().min(0).default(0.01),
  GAS_WATCH_MIN_ETH_HEDGER: z.coerce.number().min(0).default(0.01),
  GAS_WATCH_MIN_ETH_LIQUIDATOR: z.coerce.number().min(0).default(0.01),
  GAS_WATCH_MIN_ETH_VOL_SIGNER: z.coerce.number().min(0).default(0.001),
  GAS_WATCH_MIN_ETH_VOL_SENDER: z.coerce.number().min(0).default(0.01),
  GAS_WATCH_REALERT_HOURS: z.coerce.number().positive().default(6),
  TELEGRAM_ENV_FILE: z.string().default(""),
  /** Bot API base: the real endpoint, or a local test server (checked where it is used). */
  TELEGRAM_API_BASE: z.string().default("https://api.telegram.org"),
  LOG_LEVEL: z.string().default("info"),
  EXPECT_ADDRESS: addressOrEmpty,
  // API (todo 19a). The API reads Postgres through a SELECT-only role and holds no key.
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3101),
  CORS_ORIGINS: z.string().default("").transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(300),
  API_WRITE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(30),
  API_CLIENT_IP_HEADER: z.string().default("cf-connecting-ip"),
  API_QUOTE_CACHE_MS: z.coerce.number().int().min(0).default(2000),
  API_QUOTE_MAX_RPC_PER_REQUEST: z.coerce.number().int().min(1).default(2),
  API_DB_READONLY_URL: z.union([z.literal(""), z.string().url()]).default(""),
  QUOTER_ADDRESS: addressOrEmpty,
  /** "chain" = V4Quoter through the hook; "mock" = the in-process mock hook (fork network only, refused elsewhere). */
  API_QUOTER: z.enum(["chain", "mock"]).default("chain"),
});

type ParsedConfig = z.infer<typeof envSchema>;

export type RuntimeConfig = Omit<ParsedConfig, "ALCHEMY_API_KEYS" | "RPC_BACKUP_URL" | "CHAIN_ID" | "INDEXER_CONFIRMATIONS"> & {
  readonly CHAIN_ID: number;
  readonly ALCHEMY_API_KEYS: readonly string[];
  /** Resolved backup endpoint ("" = none). */
  readonly RPC_BACKUP_URL: string;
  /** Blocks behind the head the indexer waits before ingesting (0 on the fork, 2 on mainnet and testnet). */
  readonly INDEXER_CONFIRMATIONS: number;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Free keyless backup, tried only after every main endpoint failed on the same call. */
export const DEFAULT_BACKUP_RPC_URL = "https://robinhood.daybreak-rpc.network";

export function loadConfig(source: Record<string, string | undefined> = process.env): RuntimeConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Invalid service configuration: ${details}`);
  }
  const data = result.data;
  const expected = NETWORK_CHAIN_IDS[data.NETWORK];
  const chainId = data.CHAIN_ID ?? expected;
  if (chainId !== expected) {
    throw new ConfigurationError(`Invalid service configuration: CHAIN_ID ${chainId} does not match NETWORK ${data.NETWORK} (expected ${expected})`);
  }
  if (data.NETWORK === "mainnet" && data.RPC_URL_OVERRIDE.trim() !== "") {
    throw new ConfigurationError("Invalid service configuration: RPC_URL_OVERRIDE is not allowed on mainnet");
  }
  if (!data.ALCHEMY_URL_TEMPLATE.includes("{key}")) {
    throw new ConfigurationError("ALCHEMY_URL_TEMPLATE must include the {key} placeholder");
  }
  const backup =
    data.RPC_BACKUP_URL !== undefined
      ? data.RPC_BACKUP_URL.trim()
      : data.NETWORK === "mainnet" && !data.RPC_URL_OVERRIDE.trim()
        ? DEFAULT_BACKUP_RPC_URL
        : "";
  return Object.freeze({
    ...data,
    CHAIN_ID: chainId,
    RPC_BACKUP_URL: backup,
    INDEXER_CONFIRMATIONS: data.INDEXER_CONFIRMATIONS ?? (data.NETWORK === "fork" ? 0 : 2),
    ALCHEMY_API_KEYS: Object.freeze(data.ALCHEMY_API_KEYS.split(",").map((key) => key.trim()).filter(Boolean)),
  });
}

/** Key separation reported as a ConfigurationError (a key or password never appears in the text). */
export function assertKeysSeparated(source: Record<string, string | undefined> = process.env): void {
  try {
    assertDistinctKeys(source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new ConfigurationError(`Invalid service configuration: ${error.message}`);
    throw error;
  }
}

/** The jobs a service runs: enabled minus disabled. */
export function activeJobs<T extends string>(enabled: readonly T[], disabled: readonly T[]): T[] {
  return enabled.filter((job) => !disabled.includes(job));
}

export function safeConfigSummary(config: RuntimeConfig): Record<string, string | number | boolean> {
  return {
    NODE_ENV: config.NODE_ENV,
    NETWORK: config.NETWORK,
    CHAIN_ID: config.CHAIN_ID,
    confirmations: config.INDEXER_CONFIRMATIONS,
    alchemyKeys: config.ALCHEMY_API_KEYS.length,
    backupRpc: config.RPC_BACKUP_URL !== "",
    rpcOverride: config.RPC_URL_OVERRIDE !== "",
  };
}

const OPTIONAL_ENV = ["ALCHEMY_API_KEYS", "DATABASE_URL", "RPC_URL_OVERRIDE", "RPC_BACKUP_URL", "LOG_LEVEL"] as const;
export type OptionalEnvName = (typeof OPTIONAL_ENV)[number];

/** The exact (untrimmed) value, for log redaction that must match what a library echoes back. */
export function rawEnv(name: OptionalEnvName): string | undefined {
  return process.env[name];
}

/** Test preload only: points the database tests at a throwaway Postgres. */
export function setTestDatabaseEnv(url: string): void {
  process.env.TEST_DATABASE_URL = url;
  process.env.TEST_DATABASE_EPHEMERAL = "1";
}

export type TestEnvName = "TEST_DATABASE_URL" | "TEST_DATABASE_EPHEMERAL" | "PG_BIN" | "PATH" | "RHC_FORK_RPC" | "CI";
/** Trimmed value of a tooling variable, or undefined when unset or empty. */
export function optionalEnv(name: OptionalEnvName | TestEnvName): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
