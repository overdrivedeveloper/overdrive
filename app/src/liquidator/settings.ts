// Liquidator settings: its own LIQUIDATOR_* keys, validated here so the shared config.ts stays small. The job names live in
// config.ts (LIQUIDATOR_JOBS) because loadConfig validates LIQUIDATOR_ENABLED_JOBS for every service.
import { z } from "zod";
import { LIQUIDATOR_JOBS, activeJobs, type LiquidatorJob, type RuntimeConfig } from "../config";
import { assertDistinctKeys, resolveAddress, KEY_ROLES } from "../keys";
import { parseUsdg } from "../lib/fixed";

export { LIQUIDATOR_JOBS, type LiquidatorJob };

const boolFlag = (fallback: "0" | "1") => z.enum(["0", "1", "true", "false"]).default(fallback).transform((v) => v === "1" || v === "true");
const usdg = (fallback: string) => z.string().default(fallback).transform((v, ctx) => {
  try { const out = parseUsdg(v.trim()); if (out < 0n) throw new Error("negative"); return out; } catch {
    ctx.addIssue({ code: "custom", message: `not a USDG amount: ${v}` });
    return z.NEVER;
  }
});

const schema = z.object({
  LIQUIDATOR_DRY_RUN: boolFlag("1"),
  LIQUIDATOR_LIVE_CONFIRM: z.string().default(""),
  LIQUIDATOR_MAX_VAULTS_PER_BATCH: z.coerce.number().int().min(1).max(200).default(20),
  LIQUIDATOR_MIN_BONUS_USDG: usdg("1"),
  LIQUIDATOR_GAS_PRICE_MULTIPLE: z.coerce.number().min(1).max(100).default(2),
  LIQUIDATOR_MAX_INDEX_AGE_SECONDS: z.coerce.number().int().min(10).default(300),
  LIQUIDATOR_PASS_SECONDS: z.coerce.number().int().min(1).default(30),
  LIQUIDATOR_EXECUTE_MARGIN_SECONDS: z.coerce.number().int().min(0).default(60),
  LIQUIDATOR_BAD_DEBT_ALERT_USDG: usdg("100"),
  LIQUIDATOR_SCAN_LIMIT: z.coerce.number().int().min(1).max(5000).default(200),
  LIQUIDATOR_LOG_CHUNK_BLOCKS: z.coerce.number().int().min(1).max(100_000).default(2000),
  LIQUIDATOR_DEEP_WAIT_ALERT_SECONDS: z.coerce.number().int().min(60).default(600),
});

export interface LiquidatorSettings {
  dryRun: boolean;
  jobs: ReadonlySet<LiquidatorJob>;
  maxVaultsPerBatch: number;
  minBonusUsdg: bigint;
  /** LIQUIDATOR_GAS_PRICE_MULTIPLE in basis points (times BPS). */
  gasMultipleBps: bigint;
  maxIndexAgeS: number;
  passSeconds: number;
  executeMarginSeconds: number;
  badDebtAlertUsdg: bigint;
  scanLimit: number;
  logChunkBlocks: number;
  deepWaitAlertSeconds: number;
}

export class LiquidatorSettingsError extends Error {
  constructor(message: string) { super(message); this.name = "LiquidatorSettingsError"; }
}

/** R12: dry run by default; live on mainnet needs LIQUIDATOR_LIVE_CONFIRM=real-funds; the liquidator key differs from the crank,
 * hedger and vol keys (checked whenever a liquidator key is configured). */
export function loadLiquidatorSettings(env: Record<string, string | undefined>, config: Pick<RuntimeConfig, "NETWORK" | "LIQUIDATOR_ENABLED_JOBS" | "LIQUIDATOR_DISABLED_JOBS">): LiquidatorSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new LiquidatorSettingsError(`Invalid liquidator configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const s = parsed.data;
  if (config.NETWORK === "mainnet" && !s.LIQUIDATOR_DRY_RUN && s.LIQUIDATOR_LIVE_CONFIRM !== "real-funds") {
    throw new LiquidatorSettingsError("Live liquidation on mainnet needs LIQUIDATOR_LIVE_CONFIRM=real-funds (or LIQUIDATOR_DRY_RUN=1)");
  }
  assertDistinctKeys(env);
  return {
    dryRun: s.LIQUIDATOR_DRY_RUN,
    jobs: new Set(activeJobs(config.LIQUIDATOR_ENABLED_JOBS, config.LIQUIDATOR_DISABLED_JOBS)),
    maxVaultsPerBatch: s.LIQUIDATOR_MAX_VAULTS_PER_BATCH,
    minBonusUsdg: s.LIQUIDATOR_MIN_BONUS_USDG,
    gasMultipleBps: BigInt(Math.round(s.LIQUIDATOR_GAS_PRICE_MULTIPLE * 10_000)),
    maxIndexAgeS: s.LIQUIDATOR_MAX_INDEX_AGE_SECONDS,
    passSeconds: s.LIQUIDATOR_PASS_SECONDS,
    executeMarginSeconds: s.LIQUIDATOR_EXECUTE_MARGIN_SECONDS,
    badDebtAlertUsdg: s.LIQUIDATOR_BAD_DEBT_ALERT_USDG,
    scanLimit: s.LIQUIDATOR_SCAN_LIMIT,
    logChunkBlocks: s.LIQUIDATOR_LOG_CHUNK_BLOCKS,
    deepWaitAlertSeconds: s.LIQUIDATOR_DEEP_WAIT_ALERT_SECONDS,
  };
}

/** The liquidator's own address, when configured (never logged with the key). */
export const liquidatorAddress = (env: Record<string, string | undefined>) => resolveAddress(KEY_ROLES.liquidator, env);

/** Defaults for tests and the pure functions. */
export function defaultLiquidatorSettings(overrides: Partial<LiquidatorSettings> = {}): LiquidatorSettings {
  return {
    dryRun: true, jobs: new Set(LIQUIDATOR_JOBS), maxVaultsPerBatch: 20, minBonusUsdg: 1_000_000n, gasMultipleBps: 2n * 10_000n,
    maxIndexAgeS: 300, passSeconds: 30, executeMarginSeconds: 60, badDebtAlertUsdg: 100_000_000n, scanLimit: 200, logChunkBlocks: 2000,
    deepWaitAlertSeconds: 600, ...overrides,
  };
}
