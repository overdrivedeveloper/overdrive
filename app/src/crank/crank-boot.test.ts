// R22: boots with the production env shape (NODE_ENV=production, keystore form, dry run) and runs one pass of every enabled job.
// There is no node with the IOD contracts deployed in this tree, so the chain is the in-memory mock built to the real ABIs; the
// keystore, key checks, deployment parse, advisory lock, database, scheduler wiring and the real transaction queue are real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { acquireServiceLock } from "../lib/jobs";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { writeKeystorePair } from "../testing/keystore";
import { FakeChain, MARKET_ETH, MARKET_NVDA, MARKET_TSLA, WAD, logger } from "../testing/mock-chain";
import { bootCrank } from "./runtime";
import { CRANK_JOBS } from "../config";

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("crank boot", () => {
  let db: TestDatabase;
  const dirs: string[] = [];
  beforeAll(async () => { db = (await createTestDatabase("crankboot"))!; await applyMigrations(db); }, 60_000); // db + every migration: 5 s default timed out under load
  afterAll(async () => { await db.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function setup(overrides: Record<string, string> = {}) {
    const key = generatePrivateKey();
    const { env: keyEnv, dir } = writeKeystorePair("CRANK", key);
    dirs.push(dir);
    const chain = new FakeChain();
    chain.nowSeconds = BigInt(Date.parse("2026-11-17T15:00:00Z") / 1000);
    for (const m of [MARKET_TSLA, MARKET_NVDA, MARKET_ETH]) chain.addMarketPrice(m);
    for (let i = 0; i < 5; i++) chain.addGear({ id: keccak256(toHex(`boot-${i}`)), marketA: i % 2 ? MARKET_ETH : MARKET_TSLA, lastAccrual: chain.nowSeconds - 5000n, supply: WAD });
    chain.roles.add("*");
    chain.healthyGovernor();
    const deploymentFile = join(dir, "deployment.json");
    writeFileSync(deploymentFile, JSON.stringify(chain.deployment));
    const url = new URL(testDatabaseUrl()!);
    url.pathname = `/${db.name}`;
    const env = {
      NODE_ENV: "production", NETWORK: "fork", CHAIN_ID: "31337", CRANK_DRY_RUN: "1", DATABASE_URL: url.toString(), DEPLOYMENT_FILE: deploymentFile,
      ...keyEnv, ...overrides,
    };
    return { env, chain, dir, key };
  }

  test("boots_with_production_env_shape_and_runs_one_pass_of_each_job", async () => {
    const { env, chain, dir, key } = setup();
    const heartbeatFile = join(dir, "heartbeat");
    let signer = "";
    const handle = await bootCrank(env, {
      once: true, heartbeatFile, now: () => chain.wallClock(), sql: db.sql,
      makeClients: (_config, k) => { signer = privateKeyToAccount(k!).address; return chain.clients(privateKeyToAccount(k!)); },
    });
    try {
      // the signer came out of the keystore, not out of an environment variable
      expect(signer).toBe(privateKeyToAccount(key).address);
      expect(handle.config.NODE_ENV).toBe("production");
      expect([...handle.jobs].sort()).toEqual([...CRANK_JOBS].sort());
      for (const job of CRANK_JOBS) {
        expect(handle.jobs).toContain(job);
        expect(handle.results[job]).toBeDefined();
        expect(handle.results[job]).not.toHaveProperty("error");
      }
      // dry run: everything simulated, nothing applied
      expect(chain.sent.length).toBeGreaterThan(0);
      expect(chain.sent.every((s) => s.simulated)).toBe(true);
      expect(handle.results.toll).toMatchObject({ dryRun: true, accrued: 5 });
      expect(handle.results.sessions).toMatchObject({ dryRun: true, calendarUpdateNeeded: true });
      expect(chain.sessions.length).toBe(0);
      expect(chain.gears.get(keccak256(toHex("boot-0")))!.lastAccrual).toBe(chain.nowSeconds - 5000n);
      expect(handle.results.poke).toMatchObject({ poked: 3 });
      expect(existsSync(heartbeatFile)).toBe(true);
      expect(readFileSync(heartbeatFile, "utf8")).toMatch(/^\d{4}-/);
      const rows = await db.sql<{ job: string; last_error: string | null }[]>`select job, last_error from service_status where job = 'crank'`;
      expect(rows[0]?.last_error ?? null).toBeNull();
      // the single-instance lock is held: a second instance cannot take it
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 200);
      const second = await acquireServiceLock(env.DATABASE_URL, "crank", logger, abort.signal, 50);
      expect(second).toBeUndefined();
    } finally {
      await handle.stop();
    }
    // after the first instance stops, the lock is free again
    const free = await acquireServiceLock(env.DATABASE_URL, "crank", logger, AbortSignal.timeout(2000), 50);
    expect(free).toBeDefined();
    await free!.release();
  });

  test("missing_role_refuses_unless_dry_run", async () => {
    const live = setup({ CRANK_DRY_RUN: "0" });
    live.chain.roles.clear();
    const opts = (chain: FakeChain) => ({ once: true, now: () => chain.wallClock(), sql: db.sql, makeClients: (_c: unknown, k: `0x${string}` | undefined) => chain.clients(privateKeyToAccount(k!)) });
    await expect(bootCrank(live.env, opts(live.chain))).rejects.toThrow(/lacks required roles: sessions:ODMarketHours.KEEPER_ROLE/);
    // the failed boot released its lock
    const free = await acquireServiceLock(live.env.DATABASE_URL, "crank", logger, AbortSignal.timeout(2000), 50);
    expect(free).toBeDefined();
    await free!.release();
    // dry run only warns
    const dry = setup();
    dry.chain.roles.clear();
    const handle = await bootCrank(dry.env, opts(dry.chain));
    expect(handle.results.toll).toBeDefined();
    await handle.stop();
  });

  test("production_refuses_a_raw_key", async () => {
    const { env, chain } = setup({ CRANK_PRIVATE_KEY: generatePrivateKey() });
    await expect(bootCrank(env, { once: true, sql: db.sql, makeClients: () => chain.clients() })).rejects.toThrow(/keystore|not both/);
    void mkdtempSync; void tmpdir;
  });
});
