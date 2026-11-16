// Hedger environment (validated at boot), arming rules, key separation and secret stripping.
// The shared keys (NODE_ENV, NETWORK, CHAIN_ID, DATABASE_URL, DEPLOYMENT_FILE, HEDGER_ENABLED_JOBS) come from config.ts;
// the hedger-only keys are validated here so other services never parse them.
import { z } from "zod";
import { ConfigurationError, type RuntimeConfig } from "../config";
import { assertDistinctKeys, KEY_ROLES, KeyConfigError, keyVariables, resolveKey, type KeyRoleName } from "../keys";
import { parseUsdg } from "../lib/fixed";
import type { HedgerSettings, VenueName } from "./types";
import { VENUE_NAMES } from "./venues/port";

const int = (fallback: number, min = 0, max = 1_000_000_000) => z.coerce.number().int().min(min).max(max).default(fallback);
const bool01 = (fallback: "0" | "1") => z.enum(["0", "1", "true", "false"]).default(fallback).transform((v) => v === "1" || v === "true");
const usd = (fallback: string) => z.string().regex(/^\d+(\.\d{1,6})?$/).default(fallback).transform((v) => parseUsdg(v));

const hedgerSchema = z.object({
  HEDGER_DRY_RUN: bool01("1"),
  HEDGER_LIVE_CONFIRM: z.string().default(""),
  HEDGER_BAND_BPS: int(50, 1, 10_000),
  HEDGER_HARD_BAND_BPS: int(200, 1, 10_000),
  HEDGER_INTERVAL_SECONDS: int(1800, 1),
  HEDGER_COOLDOWN_SECONDS: int(120, 0),
  HEDGER_MIN_TRADE_USDG: usd("25"),
  HEDGER_MAX_SLIPPAGE_BPS: int(100, 1, 2_000),
  HEDGER_MAX_BOOK_SHARE_BPS: int(2500, 1, 10_000),
  HEDGER_CYCLE_SECONDS: int(60, 5),
  HEDGER_EQUITY_INTERVAL_SECONDS: int(3600, 60),
  HEDGER_GAMMA_BUDGET_BPS: int(40, 1, 10_000),
  HEDGER_MAX_INPUT_AGE_SECONDS: int(900, 1),
  HEDGER_MAX_VENUE_MARGIN_USDG: usd("0"),
  HEDGER_INITIAL_MARGIN_BPS: int(2000, 100, 10_000),
  HEDGER_PROXY_MAX_BPS: int(1000, 0, 10_000),
  HEDGER_VENUES: z.string().default("mock").transform((v, ctx): VenueName[] => {
    const out: VenueName[] = [];
    for (const raw of v.split(",")) {
      const name = raw.trim();
      if (!(VENUE_NAMES as readonly string[]).includes(name)) {
        ctx.addIssue({ code: "custom", message: `Unknown venue: ${name}` });
        return z.NEVER;
      }
      if (!out.includes(name as VenueName)) out.push(name as VenueName);
    }
    return out;
  }),
  HL_API_URL: z.string().url().default("https://api.hyperliquid.xyz"),
  HL_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  HL_ACCOUNT_ADDRESS: z.string().regex(/^(0x[0-9a-fA-F]{40})?$/).default(""),
  // Arcus (docs.arcus.xyz): master wallet the API key is registered to, its subaccount, and the path of the Ed25519 signing
  // key file (chmod 600; the key itself is never an env value). ARCUS_API_URL defaults from ARCUS_NETWORK.
  ARCUS_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  ARCUS_API_URL: z.union([z.literal(""), z.string().url()]).default(""),
  ARCUS_ACCOUNT_ADDRESS: z.string().regex(/^(0x[0-9a-fA-F]{40})?$/).default(""),
  ARCUS_ACCOUNT_INDEX: int(0, 0, 9),
  ARCUS_API_SIGNING_KEY_FILE: z.string().default(""),
});

export type HedgerEnv = z.infer<typeof hedgerSchema>;

export interface HedgerBoot { settings: HedgerSettings; venues: VenueName[]; env: HedgerEnv }

/** R12: parses the hedger env. Live trading on mainnet needs HEDGER_LIVE_CONFIRM=real-funds, else the process must exit. */
export function loadHedgerSettings(config: Pick<RuntimeConfig, "NETWORK">, source: Record<string, string | undefined> = process.env): HedgerBoot {
  const parsed = hedgerSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "environment"}: ${i.message}`).join("; ");
    throw new ConfigurationError(`Invalid hedger configuration: ${details}`);
  }
  const e = parsed.data;
  if (config.NETWORK === "mainnet" && !e.HEDGER_DRY_RUN && e.HEDGER_LIVE_CONFIRM !== "real-funds") {
    throw new ConfigurationError("Invalid hedger configuration: HEDGER_DRY_RUN=0 on mainnet needs HEDGER_LIVE_CONFIRM=real-funds");
  }
  if (e.HEDGER_HARD_BAND_BPS < e.HEDGER_BAND_BPS) throw new ConfigurationError("Invalid hedger configuration: HEDGER_HARD_BAND_BPS is below HEDGER_BAND_BPS");
  if (config.NETWORK === "mainnet" && e.HEDGER_VENUES.includes("mock")) throw new ConfigurationError("Invalid hedger configuration: the mock venue is refused on mainnet");
  if (e.HL_NETWORK === "testnet" && e.HL_API_URL === "https://api.hyperliquid.xyz") e.HL_API_URL = "https://api.hyperliquid-testnet.xyz";
  return {
    env: e,
    venues: e.HEDGER_VENUES,
    settings: {
      dryRun: e.HEDGER_DRY_RUN,
      bandBps: e.HEDGER_BAND_BPS,
      hardBandBps: e.HEDGER_HARD_BAND_BPS,
      intervalSeconds: e.HEDGER_INTERVAL_SECONDS,
      cooldownSeconds: e.HEDGER_COOLDOWN_SECONDS,
      minTradeUsd: e.HEDGER_MIN_TRADE_USDG,
      maxSlippageBps: e.HEDGER_MAX_SLIPPAGE_BPS,
      maxBookShareBps: e.HEDGER_MAX_BOOK_SHARE_BPS,
      cycleSeconds: e.HEDGER_CYCLE_SECONDS,
      equityIntervalSeconds: e.HEDGER_EQUITY_INTERVAL_SECONDS,
      gammaBudgetBps: e.HEDGER_GAMMA_BUDGET_BPS,
      maxInputAgeSeconds: e.HEDGER_MAX_INPUT_AGE_SECONDS,
      maxVenueMarginUsd: e.HEDGER_MAX_VENUE_MARGIN_USDG,
      initialMarginBps: e.HEDGER_INITIAL_MARGIN_BPS,
      proxyMaxBps: e.HEDGER_PROXY_MAX_BPS,
      venueMarkMaxAgeMs: 60_000,
      disagreeBps: 50,
      disagreeFloorUsd: 25_000_000n,
    },
  };
}

/** R11: the hedger key must differ from the crank, liquidator and vol signer keys. Error text never carries a key. */
export function assertHedgerKeyDistinct(source: Record<string, string | undefined> = process.env): void {
  try {
    assertDistinctKeys(source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new ConfigurationError(`Invalid hedger configuration: ${error.message}`);
    throw error;
  }
}

/** The hedger signing key (raw key in development, keystore only in production). Undefined when none is configured. */
export function loadHedgerKey(source: Record<string, string | undefined> = process.env): `0x${string}` | undefined {
  try {
    return resolveKey(KEY_ROLES.hedger, source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new ConfigurationError(`Invalid hedger configuration: ${error.message}`);
    throw error;
  }
}

/** R11: removes every other role's key variables from this process, after the distinctness check has run. */
export function stripOtherRoleSecrets(source: Record<string, string | undefined> = process.env): string[] {
  const removed: string[] = [];
  for (const role of Object.keys(KEY_ROLES) as KeyRoleName[]) {
    if (role === "hedger") continue;
    for (const variable of keyVariables(KEY_ROLES[role])) {
      if (variable in source) { delete source[variable]; removed.push(variable); }
    }
  }
  return removed;
}
