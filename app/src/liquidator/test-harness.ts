// Test harness for the liquidator's database tests: a throwaway database per file, the mock backer world, and pass deps whose
// transaction queue applies calls to the fake chain (dry run simulates only). Not used by production code.
import { getAddress } from "viem";
import type { Sql } from "postgres";
import { applyMigrations, createTestDatabase, type TestDatabase } from "../testing/db";
import { LIQUIDATOR_ACCOUNT, indexVaults, liquidationWorld } from "../testing/mock-backer";
import { logger } from "../testing/mock-chain";
import { runLiquidationPass, type PassDeps } from "./service";
import { defaultLiquidatorSettings, type LiquidatorSettings } from "./settings";
import { LiquidatorState } from "./state";

export async function liquidatorDb(label: string): Promise<TestDatabase> {
  const db = (await createTestDatabase(label))!;
  await applyMigrations(db);
  return db;
}

export async function resetTables(sql: Sql): Promise<void> {
  await sql`truncate backer_vaults, gears, liquidation_runs, liquidation_attempts, service_status`;
}

export function harness(sql: Sql, overrides: Partial<LiquidatorSettings> = {}) {
  const world = liquidationWorld();
  const settings = defaultLiquidatorSettings({ dryRun: false, ...overrides });
  world.chain.dryRun = settings.dryRun;
  const tx = world.chain.txQueue();
  let state = new LiquidatorState();
  const deps = (): PassDeps => ({
    sql, clients: world.backer.clients({ address: LIQUIDATOR_ACCOUNT }), deployment: world.chain.deployment, settings, tx, logger, state,
    account: LIQUIDATOR_ACCOUNT, sleep: async (ms: number) => { world.chain.warp(Math.ceil(ms / 1000)); },
  });
  return {
    ...world, settings, tx,
    get state() { return state; },
    /** A new process: memory is gone, only the chain and the database remain. */
    restart() { state = new LiquidatorState(); },
    index: () => indexVaults(sql, world.backer),
    pass: () => runLiquidationPass(deps()),
    /** Non-estimate calls the queue applied (or simulated in dry run), in order. */
    calls: () => world.chain.sent.filter((s) => s.label !== "estimate").map((s) => `${s.name}(${s.args.map(String).join(",")})`),
    backerAddress: getAddress(world.chain.deployment.contracts.ODBacker!),
  };
}
