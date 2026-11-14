import { describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { loadLiquidatorSettings } from "./settings";

const KEY_A = `0x${"11".repeat(32)}`;
const KEY_B = `0x${"22".repeat(32)}`;
const base = { DATABASE_URL: "postgres://localhost/x" };

describe("settings (R12)", () => {
  test("dry_run_default_and_mainnet_confirm_and_distinct_key", () => {
    const fork = { ...base, NETWORK: "fork" };
    const s = loadLiquidatorSettings(fork, loadConfig(fork));
    expect(s.dryRun).toBe(true);
    expect(s.maxVaultsPerBatch).toBe(20);
    expect(s.minBonusUsdg).toBe(1_000_000n);
    expect(s.gasMultipleBps).toBe(2n * 10_000n);
    expect([...s.jobs].sort()).toEqual(["execute", "scan", "seal", "watch"]);
    // live on mainnet needs the confirmation phrase
    const main = { ...base, NETWORK: "mainnet", LIQUIDATOR_DRY_RUN: "0" };
    expect(() => loadLiquidatorSettings(main, loadConfig(main))).toThrow("LIQUIDATOR_LIVE_CONFIRM=real-funds");
    const armed = { ...main, LIQUIDATOR_LIVE_CONFIRM: "real-funds" };
    expect(loadLiquidatorSettings(armed, loadConfig(armed)).dryRun).toBe(false);
    // dry run on mainnet needs nothing more
    const dry = { ...base, NETWORK: "mainnet" };
    expect(loadLiquidatorSettings(dry, loadConfig(dry)).dryRun).toBe(true);
    // the liquidator key differs from the crank, hedger and vol keys
    for (const other of ["CRANK_PRIVATE_KEY", "HEDGER_PRIVATE_KEY", "VOL_SIGNER_PRIVATE_KEY"]) {
      const env = { ...fork, LIQUIDATOR_PRIVATE_KEY: KEY_A, [other]: KEY_A };
      expect(() => loadLiquidatorSettings(env, loadConfig(env))).toThrow("liquidator");
    }
    const distinct = { ...fork, LIQUIDATOR_PRIVATE_KEY: KEY_A, CRANK_PRIVATE_KEY: KEY_B };
    expect(loadLiquidatorSettings(distinct, loadConfig(distinct)).dryRun).toBe(true);
    // job names: an unknown one refuses to start, a subset is honoured
    expect(() => loadConfig({ ...fork, LIQUIDATOR_ENABLED_JOBS: "scan,liquidate" })).toThrow("Unknown job: liquidate");
    const sub = { ...fork, LIQUIDATOR_ENABLED_JOBS: "scan,watch" };
    expect([...loadLiquidatorSettings(sub, loadConfig(sub)).jobs]).toEqual(["scan", "watch"]);
    expect(() => loadLiquidatorSettings({ ...fork, LIQUIDATOR_MIN_BONUS_USDG: "abc" }, loadConfig(fork))).toThrow("not a USDG amount");
  });
});
