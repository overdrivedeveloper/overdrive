// R15: boots with the production env shape (NODE_ENV=production, keystore form, dry run), takes the lock, reads the backer address
// from the deployment file, completes one scan and writes its status row. There is no node with ODBacker deployed (todo 07), so
// the chain is the mock built to the real ABIs; keystore, key checks, deployment parse, advisory lock, database and the real
// shared transaction queue (dry run: eth_estimateGas only) are real.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { acquireServiceLock } from "../lib/jobs";
import { testDatabaseUrl, type TestDatabase } from "../testing/db";
import { writeKeystorePair } from "../testing/keystore";
import { GEAR_TSLA, indexVaults, liquidationWorld } from "../testing/mock-backer";
import { WAD, logger } from "../testing/mock-chain";
import { bootLiquidator } from "./index";
import { liquidatorDb } from "./test-harness";

const FIXTURE = join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json");
const suite = testDatabaseUrl() ? describe : describe.skip;

suite("liquidator boot", () => {
  let db: TestDatabase;
  const dirs: string[] = [];
  beforeAll(async () => { db = await liquidatorDb("liqboot"); });
  afterAll(async () => { await db.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function setup(deploymentFile?: string) {
    const key = generatePrivateKey();
    const { env: keyEnv, dir } = writeKeystorePair("LIQUIDATOR", key);
    dirs.push(dir);
    const world = liquidationWorld();
    const url = new URL(testDatabaseUrl()!);
    url.pathname = `/${db.name}`;
    const env: Record<string, string> = {
      NODE_ENV: "production", NETWORK: "fork", CHAIN_ID: "31337", LIQUIDATOR_DRY_RUN: "1",
      DEPLOYMENT_FILE: deploymentFile ?? process.env.DEPLOYMENT_FILE ?? FIXTURE, ...keyEnv, DATABASE_URL: url.toString(),
    };
    return { env, key, world, dir };
  }

  test("boots_with_production_env_shape_and_scans_once", async () => {
    const { env, key, world } = setup();
    world.backer.openVault(GEAR_TSLA, 100n * 10n ** 6n, 100n * WAD);
    await indexVaults(db.sql, world.backer);
    let signer = "";
    const handle = await bootLiquidator(env, {
      once: true, sql: db.sql,
      makeClients: (_c, k) => { signer = privateKeyToAccount(k!).address; return world.backer.clients(privateKeyToAccount(k!)); },
    });
    try {
      expect(signer).toBe(privateKeyToAccount(key).address); // from the keystore, not a raw variable
      expect(handle.config.NODE_ENV).toBe("production");
      expect(handle.settings.dryRun).toBe(true);
      const file = JSON.parse(readFileSync(env.DEPLOYMENT_FILE!, "utf8")) as { contracts: { ODBacker: string } };
      expect(handle.backer).toBe(getAddress(file.contracts.ODBacker));
      expect(handle.results).toHaveLength(1);
      expect(handle.results[0]!.scanned).toBe(1);
      expect(handle.results[0]!.liquidatable).toBe(1);
      // thresholds came from the chain on this pass
      expect(world.backer.readCount.get("health")).toBe(1);
      expect(world.backer.readCount.get("upliftActive")).toBe(1);
      const [row] = await db.sql<{ last_ok: Date | null; meta: Record<string, unknown> }[]>`select last_ok, meta from service_status where job = 'liquidator'`;
      expect(row!.last_ok).not.toBeNull();
      expect(row!.meta).toMatchObject({ dryRun: true, openBatches: 0 });
      // dry run: nothing applied on chain
      expect(world.chain.sent.every((s) => s.simulated)).toBe(true);
      expect(world.backer.batches.size).toBe(0);
      // the single-instance lock is held
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 200);
      expect(await acquireServiceLock(env.DATABASE_URL!, "liquidator", logger, abort.signal, 50)).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  test("dry_run_simulates_seal_and_records_simulated", async () => {
    await db.sql`truncate backer_vaults, gears, liquidation_runs, liquidation_attempts, service_status`;
    const probe = liquidationWorld();
    const { dir } = setup();
    const file = join(dir, "deployment.json");
    writeFileSync(file, JSON.stringify(probe.chain.deployment)); // the fixture plus markets (ETH prices the gas)
    const { env, world } = setup(file);
    world.backer.openVault(GEAR_TSLA, 100n * 10n ** 6n, 100n * WAD);
    await indexVaults(db.sql, world.backer);
    const handle = await bootLiquidator(env, { once: true, sql: db.sql, makeClients: (_c, k) => world.backer.clients(privateKeyToAccount(k!)) });
    try {
      expect(handle.results[0]!.simulatedSeal).toBe(true);
      const runs = await db.sql<{ phase: string }[]>`select phase from liquidation_runs`;
      expect(runs.map((r) => r.phase)).toEqual(["simulated"]);
      expect(world.chain.sent.length).toBeGreaterThan(0);
      expect(world.chain.sent.every((s) => s.simulated && s.name === "sealBatch")).toBe(true);
      expect(world.backer.batches.size).toBe(0);
    } finally {
      await handle.stop();
    }
  });
});
