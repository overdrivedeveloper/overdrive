import { describe, expect, test } from "bun:test";
import { DEFAULT_BACKUP_RPC_URL, loadConfig } from "../config";
import { createRpcPool } from "./rpc-pool";

test("fee reads on the tx route are never served from cache", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/test",
    RPC_URL_OVERRIDE: "http://127.0.0.1:1",
  });
  let calls = 0;
  const pool = createRpcPool(config, { requestFactory: () => async () => `0x${(++calls).toString(16)}` });
  expect(await pool.request("tx", { method: "eth_gasPrice" })).toBe("0x1");
  expect(await pool.request("tx", { method: "eth_gasPrice" })).toBe("0x2");
  // Non-transaction readers may share a short-lived cached value.
  expect(await pool.request("state", { method: "eth_gasPrice" })).toBe("0x3");
  expect(await pool.request("state", { method: "eth_gasPrice" })).toBe("0x3");
});

test("a single endpoint that had one transient failure is still tried (todo 23: the fork's indexer stalled for minutes)", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/test",
    RPC_URL_OVERRIDE: "http://127.0.0.1:1",
  });
  let calls = 0;
  const pool = createRpcPool(config, {
    requestFactory: () => async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("request timed out"), { status: 503 });
      return "0x10";
    },
  });
  await expect(pool.request("logs", { method: "eth_blockNumber" })).rejects.toThrow();
  // Within the cool-down there is nothing else to fail over to: the endpoint must be retried, not skipped.
  expect(await pool.request("logs", { method: "eth_getLogs", params: [{}] })).toBe("0x10");
  expect(calls).toBe(2);
});

function poolConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/test",
    PUBLIC_RPC_URL: "https://main.example", RPC_BACKUP_URL: "https://backup.example/key-SECRET123",
    RPC_ROUTE_STATE: "public", ...extra,
  });
}

describe("backup endpoint failover", () => {
  test("a transient failure on the main endpoint is answered by the backup and counted", async () => {
    const calls: string[] = [];
    const pool = createRpcPool(poolConfig(), {
      requestFactory: (endpoint) => async () => {
        calls.push(endpoint.id);
        if (endpoint.id === "public") throw Object.assign(new Error("HTTP 503"), { status: 503 });
        return "0x1";
      },
    });
    expect(await pool.request("state", { method: "eth_chainId" })).toBe("0x1");
    expect(calls).toEqual(["public", "backup"]);
    const stats = pool.stats();
    expect(stats.failover).toMatchObject({ backupConfigured: true, usingBackup: true, count: 1, lastFrom: "public", lastTo: "backup", activeEndpoint: "backup" });
    const main = stats.endpoints.find((e) => e.id === "public")!;
    expect(main.cooling).toBe(true);
    expect(main.lastFailureAt).not.toBeNull();
    expect(stats.endpoints.find((e) => e.id === "backup")!.score).toBe(100);
  });

  test("while the main endpoint cools, calls go straight to the backup, and the main returns after its cooldown", async () => {
    let clock = 1_000_000;
    let mainDown = true;
    const calls: string[] = [];
    const pool = createRpcPool(poolConfig(), {
      now: () => clock,
      requestFactory: (endpoint) => async () => {
        calls.push(endpoint.id);
        if (endpoint.id === "public" && mainDown) throw Object.assign(new Error("timeout"), { status: 504 });
        return "0x2";
      },
    });
    await pool.request("state", { method: "eth_getBalance" });
    clock += 300; // inside the 1 s cool-down
    calls.length = 0;
    await pool.request("state", { method: "eth_getBalance" });
    expect(calls).toEqual(["backup"]);
    mainDown = false;
    clock += 1_500; // past the 1 s cool-down
    calls.length = 0;
    await pool.request("state", { method: "eth_getBalance" });
    expect(calls).toEqual(["public"]);
    expect(pool.stats().failover.usingBackup).toBe(false);
  });

  test("a slow, flaky main endpoint keeps its place: the backup is never ranked first by latency or health score", async () => {
    let clock = 5_000_000;
    const calls: string[] = [];
    let attempt = 0;
    const pool = createRpcPool(poolConfig(), {
      now: () => clock,
      requestFactory: (endpoint) => async () => {
        calls.push(endpoint.id);
        if (endpoint.id === "public") {
          attempt += 1;
          clock += 4_000; // every main answer is slow
          if (attempt % 2 === 1) throw Object.assign(new Error("HTTP 502"), { status: 502 });
        }
        return "0x3";
      },
    });
    for (let i = 0; i < 8; i += 1) {
      clock += 16 * 60_000; // past any cool-down: the main endpoint is usable again
      await pool.request("state", { method: "eth_getBalance", params: [`0x${i}`] });
    }
    const main = pool.stats().endpoints.find((e) => e.id === "public")!;
    expect(main.score).toBeLessThan(60); // slow and failing half the time: a low score...
    clock += 16 * 60_000;
    calls.length = 0;
    attempt = 1; // ...and its next answer succeeds
    await pool.request("state", { method: "eth_getBalance", params: ["0xff"] });
    expect(calls).toEqual(["public"]); // ...but it is still tried first, and the backup is not called
  });

  test("failover drill: the main endpoint is cut on purpose, the backup answers, the main is first again once it is back", async () => {
    let clock = 9_000_000;
    let mainCut = false;
    const calls: string[] = [];
    const pool = createRpcPool(poolConfig({ RPC_ROUTE_LOGS: "public" }), {
      now: () => clock,
      requestFactory: (endpoint) => async (request) => {
        calls.push(endpoint.id);
        if (endpoint.id === "public" && mainCut) throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9");
        return request.method === "eth_blockNumber" ? "0x64" : [];
      },
    });
    const logs = (n: number) => pool.request("logs", { method: "eth_getLogs", params: [{ fromBlock: `0x${n.toString(16)}`, toBlock: "0x64" }] });
    await logs(1);
    expect(calls).toEqual(["public"]);
    expect(pool.stats().failover).toMatchObject({ backupConfigured: true, usingBackup: false, count: 0, backupCalls: 0 });

    mainCut = true;
    calls.length = 0;
    await logs(2);
    expect(calls).toEqual(["public", "backup"]);
    calls.length = 0;
    await logs(3); // within the cool-down the cut main endpoint is not waited on
    expect(calls).toEqual(["backup"]);
    expect(pool.stats().failover).toMatchObject({ usingBackup: true, count: 1, lastFrom: "public", lastTo: "backup" });

    mainCut = false;
    clock += 61_000; // first cool-down over
    calls.length = 0;
    await logs(4);
    expect(calls).toEqual(["public"]); // no sticky switch: the main endpoint answers again as soon as it is tried
    expect(pool.stats().failover.usingBackup).toBe(false);
  });

  test("a rate-limited JSON-RPC batch (HTTP 429 with one error object, reported by viem without a status) fails over", async () => {
    const calls: string[] = [];
    const pool = createRpcPool(poolConfig({ RPC_ROUTE_LOGS: "public" }), {
      requestFactory: (endpoint) => async () => {
        calls.push(endpoint.id);
        if (endpoint.id === "public") {
          throw Object.assign(new Error("An unknown RPC error occurred."), {
            shortMessage: "An unknown RPC error occurred.", code: -1,
            details: "Cannot destructure property 'error' from null or undefined value",
          });
        }
        return [];
      },
    });
    expect(await pool.requestBatch("logs", [{ method: "eth_getLogs", params: [{}] }, { method: "eth_getLogs", params: [{}] }])).toEqual([[], []]);
    expect(calls).toEqual(["public", "public", "backup", "backup"]);
  });

  test("execution reverts are not failover events and never touch the backup", async () => {
    const calls: string[] = [];
    const pool = createRpcPool(poolConfig(), {
      requestFactory: (endpoint) => async () => {
        calls.push(endpoint.id);
        throw Object.assign(new Error("execution reverted"), { code: 3 });
      },
    });
    await expect(pool.request("state", { method: "eth_call", params: [{}, "latest"] })).rejects.toThrow("execution reverted");
    expect(calls).toEqual(["public"]);
    expect(pool.stats().failover.count).toBe(0);
  });

  test("the backup URL never appears in an error message", async () => {
    const pool = createRpcPool(poolConfig(), {
      requestFactory: () => async () => { throw new Error("bad request to https://backup.example/key-SECRET123"); },
    });
    const error = await pool.request("state", { method: "eth_getBalance", params: ["0x1"] }).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("SECRET123");
  });

  test("without a backup the stats say so and routing is unchanged", async () => {
    const pool = createRpcPool(poolConfig({ RPC_BACKUP_URL: "" }), { requestFactory: () => async () => "0x1" });
    await pool.request("state", { method: "eth_chainId" });
    expect(pool.stats().failover).toMatchObject({ backupConfigured: false, usingBackup: false, count: 0 });
    expect(pool.stats().endpoints.map((e) => e.id)).toEqual(["public"]);
  });

  test("batched calls fail over together", async () => {
    const pool = createRpcPool(poolConfig(), {
      requestFactory: (endpoint) => async () => {
        if (endpoint.id === "public") throw Object.assign(new Error("fetch failed"), { status: 500 });
        return "0xa";
      },
    });
    expect(await pool.requestBatch("state", [{ method: "eth_blockNumber" }, { method: "eth_chainId" }])).toEqual(["0xa", "0xa"]);
    expect(pool.stats().failover.backupCalls).toBe(2);
  });
});

describe("backup endpoint configuration (switches on by itself)", () => {
  const db = { DATABASE_URL: "postgres://user:pass@localhost:5432/test", POSTGRES_PASSWORD: "x" };
  test("mainnet with no setting gets the free default backup, after the official public RPC", () => {
    const config = loadConfig({ ...db, NETWORK: "mainnet" });
    expect(config.RPC_BACKUP_URL).toBe(DEFAULT_BACKUP_RPC_URL);
    const pool = createRpcPool(config, { requestFactory: () => async () => "0x1" });
    expect(pool.stats().endpoints.map((e) => e.id)).toEqual(["public", "backup"]);
    expect(pool.stats().failover.backupConfigured).toBe(true);
  });
  test("an explicit URL wins; an explicit empty value runs without a backup", () => {
    expect(loadConfig({ ...db, NETWORK: "mainnet", RPC_BACKUP_URL: "https://other.example" }).RPC_BACKUP_URL).toBe("https://other.example");
    expect(loadConfig({ ...db, NETWORK: "mainnet", RPC_BACKUP_URL: "" }).RPC_BACKUP_URL).toBe("");
  });
  test("the fork profile and a single-endpoint override never get a mainnet backup by default", () => {
    expect(loadConfig({ ...db, NETWORK: "fork" }).RPC_BACKUP_URL).toBe("");
    expect(loadConfig({ ...db, NETWORK: "testnet", RPC_URL_OVERRIDE: "http://127.0.0.1:8545" }).RPC_BACKUP_URL).toBe("");
  });
});

describe("R9", () => {
  test("no_cache_for_logs_and_backoff", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://user:pass@localhost:5432/test", PUBLIC_RPC_URL: "https://main.example", RPC_ROUTE_LOGS: "public" });
    let calls = 0;
    const pool = createRpcPool(config, { requestFactory: () => async () => `0x${(++calls).toString(16)}` });
    // Logs and header reads (latest or by number) always reach the node, so a reorg is visible.
    expect(await pool.request("logs", { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] })).toBe("0x1");
    expect(await pool.request("logs", { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2" }] })).toBe("0x2");
    expect(await pool.request("logs", { method: "eth_getBlockByNumber", params: ["0x10", false] })).toBe("0x3");
    expect(await pool.request("logs", { method: "eth_getBlockByNumber", params: ["0x10", false] })).toBe("0x4");
    expect(await pool.request("logs", { method: "eth_getBlockByNumber", params: ["latest", false] })).toBe("0x5");
    expect(await pool.request("logs", { method: "eth_getBlockByNumber", params: ["latest", false] })).toBe("0x6");
    // Back-off: 1 s, doubling, capped at 30 s, on 429 and 5xx.
    let clock = 1_000_000;
    let fail = true;
    const hit: number[] = [];
    const backoffPool = createRpcPool(config, {
      now: () => clock,
      requestFactory: () => async () => {
        hit.push(clock);
        if (fail) throw Object.assign(new Error("too many requests"), { status: 429 });
        return "0x1";
      },
    });
    const cooling = () => backoffPool.stats().endpoints[0]!.coolDownMs;
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const want of expected) {
      await expect(backoffPool.request("logs", { method: "eth_blockNumber" })).rejects.toThrow();
      expect(cooling()).toBe(want);
      clock += want;
    }
    fail = false;
    expect(await backoffPool.request("logs", { method: "eth_getLogs", params: [{}] })).toBe("0x1");
  });
});
