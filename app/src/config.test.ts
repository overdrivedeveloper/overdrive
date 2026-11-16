import { describe, expect, test } from "bun:test";
import { ConfigurationError, activeJobs, loadConfig } from "./config";

const base = { DATABASE_URL: "postgres://localhost/x" };

describe("loadConfig", () => {
  test("refuses_unknown_job_and_chain_mismatch", () => {
    expect(() => loadConfig({ ...base, NETWORK: "mainnet", CHAIN_ID: "31337" })).toThrow("does not match NETWORK");
    expect(() => loadConfig({ ...base, NETWORK: "fork", CHAIN_ID: "4663" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...base, NETWORK: "mainnet", CHAIN_ID: "4663", RPC_URL_OVERRIDE: "http://127.0.0.1:8545" })).toThrow("RPC_URL_OVERRIDE");
    expect(() => loadConfig({ ...base, CRANK_ENABLED_JOBS: "toll,prices" })).toThrow("Unknown job: prices");
    expect(() => loadConfig({ ...base, HEDGER_DISABLED_JOBS: "cycle,,post" })).toThrow("Unknown job: ");
    expect(() => loadConfig({ ...base, HEDGER_ENABLED_JOBS: "hedge" })).toThrow("Unknown job: hedge");
    expect(() => loadConfig({ ...base, CRANK_ENABLED_JOBS: "risk-monitor,heartbeat", HEDGER_ENABLED_JOBS: "cycle,post,reconcile" })).not.toThrow();
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
  test("each network gets its own public RPC and Alchemy host; the other network's host is refused", () => {
    const testnet = loadConfig({ ...base, NETWORK: "testnet", ALCHEMY_API_KEYS: "k" });
    expect(testnet.PUBLIC_RPC_URL).toBe("https://rpc.testnet.chain.robinhood.com");
    expect(testnet.ALCHEMY_URL_TEMPLATE).toBe("https://robinhood-testnet.g.alchemy.com/v2/{key}");
    const main = loadConfig({ ...base, NETWORK: "mainnet", PUBLIC_RPC_URL: "", ALCHEMY_URL_TEMPLATE: "" });
    expect(main.PUBLIC_RPC_URL).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(main.ALCHEMY_URL_TEMPLATE).toBe("https://robinhood-mainnet.g.alchemy.com/v2/{key}");
    expect(loadConfig(base).ALCHEMY_URL_TEMPLATE).toContain("robinhood-mainnet");
    expect(() => loadConfig({ ...base, NETWORK: "testnet", ALCHEMY_URL_TEMPLATE: "https://robinhood-mainnet.g.alchemy.com/v2/{key}" })).toThrow("ALCHEMY_URL_TEMPLATE points at the other");
    expect(() => loadConfig({ ...base, NETWORK: "testnet", PUBLIC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com/" })).toThrow("PUBLIC_RPC_URL points at the other");
    expect(() => loadConfig({ ...base, NETWORK: "testnet", RPC_BACKUP_URL: "https://robinhood.daybreak-rpc.network" })).toThrow("RPC_BACKUP_URL");
    expect(() => loadConfig({ ...base, NETWORK: "mainnet", PUBLIC_RPC_URL: "https://rpc.testnet.chain.robinhood.com" })).toThrow("PUBLIC_RPC_URL points at the other");
    expect(() => loadConfig({ ...base, NETWORK: "mainnet", ALCHEMY_URL_TEMPLATE: "https://robinhood-testnet.g.alchemy.com/v2/{key}" })).toThrow("ALCHEMY_URL_TEMPLATE");
    expect(() => loadConfig({ ...base, NETWORK: "testnet", ALCHEMY_URL_TEMPLATE: "https://example.test/v2/" })).toThrow("{key}");
  });
  test("an empty job list is allowed and disabled names are removed", () => {
    const config = loadConfig({ ...base, CRANK_ENABLED_JOBS: "", HEDGER_DISABLED_JOBS: "reconcile" });
    expect(config.CRANK_ENABLED_JOBS).toEqual([]);
    expect(activeJobs(config.HEDGER_ENABLED_JOBS, config.HEDGER_DISABLED_JOBS)).toEqual(["cycle", "post"]);
  });
  test("a missing database url is refused", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
  });
});

test("holder perk config: defaults, lowercased exclusion lists, bad address refused", () => {
  const base = { DATABASE_URL: "postgres://x/y" };
  const c = loadConfig(base);
  expect([c.OVRD_TOKEN_ADDRESS, c.HOLDER_TIER_HOLDER_MIN, c.HOLDER_TIER_WHALE_MIN, c.USER_COUNT_EXCLUDE_TEAM]).toEqual(["", 100_000, 1_000_000, []]);
  expect(loadConfig({ ...base, USER_COUNT_EXCLUDE_BOTS: " 0x00000000000000000000000000000000000000AB ,0x00000000000000000000000000000000000000cd" }).USER_COUNT_EXCLUDE_BOTS).toEqual(["0x00000000000000000000000000000000000000ab", "0x00000000000000000000000000000000000000cd"]);
  expect(() => loadConfig({ ...base, USER_COUNT_EXCLUDE_TEAM: "nope" })).toThrow();
});
