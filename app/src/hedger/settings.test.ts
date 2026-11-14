import { describe, expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import { ConfigurationError } from "../config";
import { assertHedgerKeyDistinct, loadHedgerSettings, stripOtherRoleSecrets } from "./settings";

describe("hedger settings", () => {
  test("hedger_key_distinct_and_other_secrets_stripped", () => {
    const shared = generatePrivateKey();
    for (const other of ["CRANK_PRIVATE_KEY", "LIQUIDATOR_PRIVATE_KEY", "VOL_SIGNER_PRIVATE_KEY"]) {
      const env = { HEDGER_PRIVATE_KEY: shared, [other]: shared };
      expect(() => assertHedgerKeyDistinct(env)).toThrow(ConfigurationError);
      try { assertHedgerKeyDistinct(env); } catch (error) { expect(String(error)).not.toContain(shared.slice(2)); }
    }
    expect(() => assertHedgerKeyDistinct({ HEDGER_PRIVATE_KEY: generatePrivateKey(), CRANK_PRIVATE_KEY: generatePrivateKey() })).not.toThrow();

    const env: Record<string, string | undefined> = {
      HEDGER_PRIVATE_KEY: "0x01", HEDGER_KEYSTORE: "/h", HEDGER_KEYSTORE_PASSWORD_FILE: "/hp",
      CRANK_PRIVATE_KEY: "0x02", CRANK_KEYSTORE: "/c", LIQUIDATOR_KEYSTORE_PASSWORD_FILE: "/lp", VOL_SIGNER_PRIVATE_KEY: "0x03",
      VOL_SENDER_KEYSTORE: "/vs", PAYMASTER_SIGNER_PRIVATE_KEY: "0x04", AGENT_PRIVATE_KEY: "0x05", DATABASE_URL: "postgres://x",
    };
    const removed = stripOtherRoleSecrets(env);
    expect(removed.sort()).toEqual(["AGENT_PRIVATE_KEY", "CRANK_KEYSTORE", "CRANK_PRIVATE_KEY", "LIQUIDATOR_KEYSTORE_PASSWORD_FILE", "PAYMASTER_SIGNER_PRIVATE_KEY", "VOL_SENDER_KEYSTORE", "VOL_SIGNER_PRIVATE_KEY"]);
    expect(Object.keys(env).sort()).toEqual(["DATABASE_URL", "HEDGER_KEYSTORE", "HEDGER_KEYSTORE_PASSWORD_FILE", "HEDGER_PRIVATE_KEY"]);
  });

  test("mainnet_live_needs_confirm", () => {
    // default is a dry run, everywhere
    expect(loadHedgerSettings({ NETWORK: "mainnet" }, { HEDGER_VENUES: "arcus" }).settings.dryRun).toBe(true);
    expect(() => loadHedgerSettings({ NETWORK: "mainnet" }, { HEDGER_DRY_RUN: "0", HEDGER_VENUES: "arcus" })).toThrow("HEDGER_LIVE_CONFIRM=real-funds");
    expect(() => loadHedgerSettings({ NETWORK: "mainnet" }, { HEDGER_DRY_RUN: "0", HEDGER_LIVE_CONFIRM: "yes", HEDGER_VENUES: "arcus" })).toThrow(ConfigurationError);
    expect(loadHedgerSettings({ NETWORK: "mainnet" }, { HEDGER_DRY_RUN: "0", HEDGER_LIVE_CONFIRM: "real-funds", HEDGER_VENUES: "arcus" }).settings.dryRun).toBe(false);
    // not mainnet: live is allowed without the confirm
    expect(loadHedgerSettings({ NETWORK: "fork" }, { HEDGER_DRY_RUN: "0" }).settings.dryRun).toBe(false);
    // the mock venue never runs on mainnet, unknown venues refuse, the hard band cannot sit inside the band
    expect(() => loadHedgerSettings({ NETWORK: "mainnet" }, { HEDGER_VENUES: "mock" })).toThrow("mock venue");
    expect(() => loadHedgerSettings({ NETWORK: "fork" }, { HEDGER_VENUES: "mock,binance" })).toThrow("Unknown venue: binance");
    expect(() => loadHedgerSettings({ NETWORK: "fork" }, { HEDGER_BAND_BPS: "300" })).toThrow("HARD_BAND");
    const s = loadHedgerSettings({ NETWORK: "fork" }, { HEDGER_MIN_TRADE_USDG: "25", HL_NETWORK: "testnet" });
    expect(s.settings.minTradeUsd).toBe(25_000_000n);
    expect(s.settings.bandBps).toBe(50);
    expect(s.settings.hardBandBps).toBe(200);
    expect(s.env.HL_API_URL).toBe("https://api.hyperliquid-testnet.xyz");
  });
});
