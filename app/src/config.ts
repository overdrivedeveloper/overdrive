import { z } from "zod";
import { KeyConfigError, assertDistinctKeys } from "./keys";

/** Valid job names, one exported const per service. Config validation imports them, so an unknown name fails at boot. */
export const CRANK_JOBS = ["sessions", "toll", "poke", "vol-watch", "queued-sells", "fees", "risk-monitor", "admin-watch", "gas-watch", "pyth-push", "heartbeat"] as const;
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

/** A csv of 0x addresses, lowercased; anything else throws at boot. */
function addressList() {
  return z.string().default("").transform((value, ctx): string[] => {
    const out: string[] = [];
    for (const raw of value.split(",")) {
      const item = raw.trim();
      if (item === "") continue;
      if (!/^0x[0-9a-fA-F]{40}$/.test(item)) { ctx.addIssue({ code: "custom", message: `Not an address: ${item}` }); return z.NEVER; }
      out.push(item.toLowerCase());
    }
    return out;
  });
}

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
  /** Empty or unset = the NETWORK's own public RPC (NETWORK_RPC_DEFAULTS). */
  PUBLIC_RPC_URL: z.union([z.literal(""), z.string().url()]).optional(),
  RPC_URL_OVERRIDE: z.string().default(""),
  RPC_BACKUP_URL: z.union([z.literal(""), z.string().url()]).optional(),
  ALCHEMY_API_KEYS: z.string().default(""),
  /** Empty or unset = the NETWORK's own Alchemy host (NETWORK_RPC_DEFAULTS). */
  ALCHEMY_URL_TEMPLATE: z.string().optional(),
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
  /** Pyth push (I5-2). Hermes serves the signed updates; with no key the job stays idle and says so. */
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  PYTH_HERMES_API_KEY: z.string().trim().default(""),
  PYTH_HERMES_AUTH_HEADER: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).default("x-api-key"),
  /** Must stay below every market's refMaxAge (mainnet: 120 s); the job warns when it does not. */
  PYTH_PUSH_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(45),
  /** Push only when the on-chain print is older than this share of the market's refMaxAge. */
  PYTH_PUSH_FRESH_PERCENT: z.coerce.number().int().min(10).max(90).default(50),
  PYTH_PUSH_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
  PYTH_PUSH_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  /** Update fees plus gas the job may spend per UTC day, in ETH. */
  PYTH_PUSH_DAILY_BUDGET_ETH: z.coerce.number().min(0).max(10).default(0.02),
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
  // V4Quoter + IODMinter.quote, plus IODMinter.valuePerToken for a sell queued in a market that is not live (I8-2).
  API_QUOTE_MAX_RPC_PER_REQUEST: z.coerce.number().int().min(1).default(3),
  API_DB_READONLY_URL: z.union([z.literal(""), z.string().url()]).default(""),
  QUOTER_ADDRESS: addressOrEmpty,
  // Holder perks (todo 37). The $OVRD address comes from the launchpad at launch (D11): empty = tiers report "not live" and make no RPC call.
  OVRD_TOKEN_ADDRESS: addressOrEmpty,
  HOLDER_TIER_HOLDER_MIN: z.coerce.number().int().positive().default(100_000),
  HOLDER_TIER_WHALE_MIN: z.coerce.number().int().positive().default(1_000_000),
  // Real-user counter: wallets that never count (csv of 0x addresses): team, bots, Safes. The deployment's own Safes and timelock are always excluded too.
  USER_COUNT_EXCLUDE_TEAM: addressList(),
  USER_COUNT_EXCLUDE_BOTS: addressList(),
  USER_COUNT_EXCLUDE_SAFES: addressList(),
  /** "chain" = V4Quoter through the hook; "mock" = the in-process mock hook (fork network only, refused elsewhere). */
  API_QUOTER: z.enum(["chain", "mock"]).default("chain"),
});

/** Every variable this file reads. app/.env.example must list exactly these (app/test/env-example.test.ts). */
export const CONFIG_ENV_KEYS: readonly string[] = Object.freeze(Object.keys(envSchema.shape));

type ParsedConfig = z.infer<typeof envSchema>;

export type RuntimeConfig = Omit<
  ParsedConfig,
  "ALCHEMY_API_KEYS" | "RPC_BACKUP_URL" | "CHAIN_ID" | "INDEXER_CONFIRMATIONS" | "PUBLIC_RPC_URL" | "ALCHEMY_URL_TEMPLATE"
> & {
  readonly CHAIN_ID: number;
  /** Resolved public RPC (the NETWORK's own when unset). */
  readonly PUBLIC_RPC_URL: string;
  /** Resolved Alchemy URL template (the NETWORK's own host when unset). */
  readonly ALCHEMY_URL_TEMPLATE: string;
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

/**
 * Each network's own endpoints. The fork forks mainnet, so it shares mainnet's. Before these existed the template
 * defaulted to the mainnet Alchemy host for every NETWORK, so a testnet box with an Alchemy key reached mainnet and
 * every keyed service refused to start (chain 4663, expected 46630).
 */
export const NETWORK_RPC_DEFAULTS = {
  mainnet: { publicRpc: "https://rpc.mainnet.chain.robinhood.com", alchemy: "https://robinhood-mainnet.g.alchemy.com/v2/{key}" },
  testnet: { publicRpc: "https://rpc.testnet.chain.robinhood.com", alchemy: "https://robinhood-testnet.g.alchemy.com/v2/{key}" },
  fork: { publicRpc: "https://rpc.mainnet.chain.robinhood.com", alchemy: "https://robinhood-mainnet.g.alchemy.com/v2/{key}" },
} as const;

/** A Robinhood Chain host that names the other network: refused at load, before any RPC call. */
function namesOtherNetwork(network: "mainnet" | "testnet" | "fork", url: string): boolean {
  const host = url.replace(/^[a-z]+:\/\//i, "").split(/[/:?#]/)[0]!.toLowerCase();
  const mainnetHosts = ["rpc.mainnet.chain.robinhood.com", "robinhood-mainnet.g.alchemy.com", "robinhood.daybreak-rpc.network"];
  const testnetHosts = ["rpc.testnet.chain.robinhood.com", "robinhood-testnet.g.alchemy.com"];
  return (network === "testnet" ? mainnetHosts : testnetHosts).includes(host);
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
  const defaults = NETWORK_RPC_DEFAULTS[data.NETWORK];
  const publicRpc = (data.PUBLIC_RPC_URL ?? "").trim() || defaults.publicRpc;
  const alchemyTemplate = (data.ALCHEMY_URL_TEMPLATE ?? "").trim() || defaults.alchemy;
  if (!alchemyTemplate.includes("{key}")) {
    throw new ConfigurationError("ALCHEMY_URL_TEMPLATE must include the {key} placeholder");
  }
  const named = [["PUBLIC_RPC_URL", publicRpc], ["ALCHEMY_URL_TEMPLATE", alchemyTemplate], ["RPC_URL_OVERRIDE", data.RPC_URL_OVERRIDE], ["RPC_BACKUP_URL", data.RPC_BACKUP_URL ?? ""]] as const;
  for (const [name, url] of named) {
    if (namesOtherNetwork(data.NETWORK, url)) {
      throw new ConfigurationError(`Invalid service configuration: ${name} points at the other Robinhood Chain network, not NETWORK ${data.NETWORK}`);
    }
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
    PUBLIC_RPC_URL: publicRpc,
    ALCHEMY_URL_TEMPLATE: alchemyTemplate,
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

/** Environment of the team Telegram bot (src/bin/telegram-bot.ts). The bot holds no key and no database, so it does not
 * need loadConfig; it reads only these names, here, so every env read stays in this file. */
export const TELEGRAM_BOT_ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OPS_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_BOT_RATE_PER_MINUTE", "TELEGRAM_BOT_API_URL", "TELEGRAM_API_BASE", "API_PORT"] as const;
export function telegramBotEnv(source: Record<string, string | undefined> = process.env): { envFile: string; env: Record<string, string | undefined> } {
  const env: Record<string, string | undefined> = {};
  for (const key of TELEGRAM_BOT_ENV_KEYS) env[key] = source[key];
  return { envFile: source.TELEGRAM_ENV_FILE ?? "", env };
}
