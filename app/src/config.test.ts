import { describe, expect, test } from "bun:test";
import { ConfigurationError, activeJobs, loadConfig } from "./config";

const base = { DATABASE_URL: "postgres://localhost/x" };

describe("loadConfig", () => {
  test("refuses_unknown_job_and_chain_mismatch", () => {
    expect(() => loadConfig({ ...base, NETWORK: "mainnet", CHAIN_ID: "31337" })).toThrow("does not match NETWORK");
    expect(() => loadConfig({ ...base, NETWORK: "fork", CHAIN_ID: "4663" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...base, NETWORK: "mainnet", CHAIN_ID: "4663", RPC_URL_OVERRIDE: "http://127.0.0.1:8545" })).toThrow("RPC_URL_OVERRIDE");
    expect(() => loadConfig({ ...base, CRANK_ENABLED_JOBS: "toll,prices" })).toThrow("Unknown job: prices");
    expect(() => loadConfig({ ...base, HEDGER_DISABLED_JOBS: "hedge,,equity" })).toThrow("Unknown job: ");
    expect(() => loadConfig({ ...base, LIQUIDATOR_ENABLED_JOBS: "scan, nope" })).toThrow("Unknown job: nope");
  });
  test("defaults per network", () => {
    const fork = loadConfig(base);
    expect(fork.NETWORK).toBe("fork");
    expect(fork.CHAIN_ID).toBe(31337);
    expect(fork.INDEXER_CONFIRMATIONS).toBe(0);
    expect(fork.RPC_BACKUP_URL).toBe("");
    const main = loadConfig({ ...base, NETWORK: "mainnet" });
    expect(main.CHAIN_ID).toBe(4663);
    expect(main.INDEXER_CONFIRMATIONS).toBe(2);
    expect(main.RPC_BACKUP_URL).toContain("https://");
    expect(loadConfig({ ...base, NETWORK: "testnet" }).CHAIN_ID).toBe(46630);
  });
  test("an empty job list is allowed and disabled names are removed", () => {
    const config = loadConfig({ ...base, CRANK_ENABLED_JOBS: "", HEDGER_DISABLED_JOBS: "funding" });
    expect(config.CRANK_ENABLED_JOBS).toEqual([]);
    expect(activeJobs(config.HEDGER_ENABLED_JOBS, config.HEDGER_DISABLED_JOBS)).toEqual(["hedge", "equity"]);
  });
  test("a missing database url is refused", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
  });
});
