import { describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { keccak256, toHex, type Hex } from "viem";
import { loadConfig } from "../config";
import { FakeChain, MARKET_ETH, MARKET_TSLA, WAD, logger, mockDeployment, nullSql } from "../testing/mock-chain";
import { createTollJob } from "./jobs/toll";
import { bootCrank, buildJobs, resolveCrankJobs, startCrank, JOB_TIERS } from "./runtime";
import { createTxQueue, withPriority } from "./tx";
import { CRANK_JOBS } from "../config";

const baseEnv = { NODE_ENV: "development", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: "postgres://localhost/unused", DEPLOYMENT_FILE: "/nonexistent.json" };

describe("runtime", () => {
  test("unknown_job_refuses_to_start", async () => {
    let connected = 0;
    const options = { makeClients: () => { connected++; throw new Error("must not connect"); }, sql: nullSql };
    await expect(bootCrank({ ...baseEnv, CRANK_ENABLED_JOBS: "toll,prices" }, options)).rejects.toThrow("Unknown job: prices");
    await expect(bootCrank({ ...baseEnv, CRANK_DISABLED_JOBS: "sessions,nope" }, options)).rejects.toThrow("Unknown job: nope");
    await expect(bootCrank({ ...baseEnv, CRANK_ENABLED_JOBS: "toll,,poke" }, options)).rejects.toThrow("Unknown job: ");
    expect(connected).toBe(0);
    expect(resolveCrankJobs({ CRANK_ENABLED_JOBS: "toll,poke,fees", CRANK_DISABLED_JOBS: "fees" })).toEqual(["toll", "poke"]);
    expect(resolveCrankJobs({})).toEqual([...CRANK_JOBS]);
  });

  test("lock_lost_stops_process", async () => {
    const chain = new FakeChain();
    chain.addMarketPrice(MARKET_TSLA);
    const exits: number[] = [];
    let state: "held" | "lost" = "held";
    const config = loadConfig({ NODE_ENV: "test", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: "postgres://localhost/unused", DEPLOYMENT_FILE: "x", CRANK_ENABLED_JOBS: "heartbeat" });
    const handle = await startCrank({
      config, logger, sql: nullSql, clients: chain.clients(), deployment: chain.deployment, tx: chain.txQueue(), now: () => chain.wallClock(),
      lock: { check: async () => state, release: async () => undefined }, heartbeatFile: `${process.env.TMPDIR ?? "/tmp"}/od-hb-${Date.now()}`,
      onExit: (code) => exits.push(code),
    });
    expect(handle.jobs).toEqual(["heartbeat"]);
    const outcome = await Promise.race([handle.done.then(() => "stopped"), Bun.sleep(150).then(() => "running")]);
    expect(outcome).toBe("running");
    expect(exits).toEqual([]);
    // the lock is taken by another instance: the next beat stops the process with exit code 1
    state = "lost";
    await handle.stop();
    const again = await startCrank({
      config, logger, sql: nullSql, clients: chain.clients(), deployment: chain.deployment, tx: chain.txQueue(), now: () => chain.wallClock(),
      lock: { check: async () => "lost", release: async () => undefined }, heartbeatFile: `${process.env.TMPDIR ?? "/tmp"}/od-hb2-${Date.now()}`, onExit: (code) => exits.push(code),
    });
    await again.done;
    expect(exits).toEqual([1]);
    expect(again.exitCode).toBe(1);
    await again.stop();
  });

  test("user_queue_cannot_starve_toll", async () => {
    const chain = new FakeChain();
    chain.nowSeconds = BigInt(Date.parse("2026-11-17T15:00:00Z") / 1000);
    chain.addGear({ id: keccak256(toHex("g1")), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n, supply: WAD });
    for (const m of [MARKET_TSLA]) chain.addMarketPrice(m);
    // the REAL tx queue over the mock chain's node surface, with a slow node so transactions really queue up
    const account = privateKeyToAccount(generatePrivateKey());
    const clients = chain.clients(account);
    const node = clients.txClient as unknown as { estimateGas: (call: { to: `0x${string}`; data: Hex }) => Promise<bigint> };
    const original = node.estimateGas;
    node.estimateGas = async (call) => { await Bun.sleep(2); return original(call); };
    chain.dryRun = true;
    const tx = createTxQueue(clients, { dryRun: true, logger });
    const ctx = { ...chain.context(nullSql), tx, clients };
    const user = withPriority(tx, "user");
    let userDone = 0;
    const flood = Array.from({ length: 300 }, () => user.submit({ label: "queued-sells:fill", to: ctx.deployment.contracts.ODOracleGuard as `0x${string}`, data: "0x" }).then(() => userDone++, () => userDone++));
    const started = Date.now();
    const result = await createTollJob(ctx)();
    // the toll transaction went ahead of the waiting user transactions: at most the one in flight finished before it
    expect(result.accrued).toBe(1);
    expect(userDone).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(500);
    await Promise.all(flood);
  });

  test("job_tiers_put_protocol_work_first", () => {
    const order = CRANK_JOBS.filter((j) => JOB_TIERS[j] === "protocol");
    expect(order).toEqual(["sessions", "toll", "poke", "fees"]);
    expect(JOB_TIERS["queued-sells"]).toBe("user");
    const chain = new FakeChain();
    const ctx = chain.context(nullSql);
    const jobs = buildJobs(ctx, [...CRANK_JOBS], { heartbeatFile: "/tmp/x", onLockLost: () => undefined }, { forceToll: false, forcePoke: false });
    const names = jobs.map((j) => j.name);
    expect(names.indexOf("toll")).toBeLessThan(names.indexOf("vol-watch"));
    void mockDeployment;
  });
});
