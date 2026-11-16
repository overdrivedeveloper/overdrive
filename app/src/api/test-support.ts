// Shared harness for the API tests: a throwaway migrated database, a deployment with all five powers and a pair, seeded
// rows, and the mock hook as the chain. Not a test file.
import { keccak256, toHex } from "viem";
import pino from "pino";
import type { Sql } from "postgres";
import { loadConfig, type RuntimeConfig } from "../config";
import type { Deployment } from "../lib/deployments";
import { testDeployment } from "../indexer/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { createApiSql } from "../db/client";
import { pairMarketKey } from "../lib/volpost";
import { MockHook, mockBook, mockGear, mockHookFor, type MockBook, type MockGear } from "../testing/mock-hook";
export { mockBook, mockGear, mockHookFor };
import { createApiApp } from "./app";
import { TtlCache } from "./cache";
import type { ApiChain } from "./chain-reads";
import type { ApiDependencies } from "./types";

export const WAD = 10n ** 18n;
export const addr = (n: number | string): `0x${string}` => `0x${keccak256(toHex(String(n))).slice(26)}`;
export const idOf = (symbol: string) => keccak256(toHex(symbol));

export const POWERS = [
  { gear: "CRUISE", power: "1.5", powerWad: 15n * WAD / 10n }, { gear: "SPORT", power: "2", powerWad: 2n * WAD }, { gear: "RACE", power: "3", powerWad: 3n * WAD },
  { gear: "ECO", power: "0.5", powerWad: WAD / 2n }, { gear: "REVERSE", power: "-1", powerWad: -WAD },
] as const;

/** TSLA at all five powers, plus the NVDA-over-TSLA pair (Sport). */
export function apiDeployment(): Deployment {
  const base = testDeployment();
  const gears: Deployment["gears"] = POWERS.map((p) => ({
    id: idOf(`TSLA-${p.gear}`) as `0x${string}`, symbol: `TSLA-${p.gear}`, gear: p.gear, power: p.power, marketA: "TSLA", marketB: null,
    token: addr(`TSLA-${p.gear}`), poolId: idOf(`pool-TSLA-${p.gear}`) as `0x${string}`, capUsd: "1000000000", spreadBps: 40, unitUsd: "100",
  }));
  gears.push({ id: idOf("NVDA/TSLA-SPORT") as `0x${string}`, symbol: "NVDA/TSLA-SPORT", gear: "SPORT", power: "2", marketA: "NVDA", marketB: "TSLA", token: addr("NVDA/TSLA-SPORT"), poolId: idOf("pool-pair") as `0x${string}`, capUsd: "1000000000", spreadBps: 60, unitUsd: "100" });
  return { ...base, network: "fork", gears };
}

export function testConfig(over: Record<string, string> = {}): RuntimeConfig {
  return loadConfig({ NODE_ENV: "test", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: "postgres://localhost/unused", DEPLOYMENT_FILE: "x.json", API_RATE_LIMIT_PER_MINUTE: "0", API_QUOTE_CACHE_MS: "0", ...over });
}

export interface Harness {
  db: TestDatabase; sql: Sql; raw: Sql; deployment: Deployment; hook: MockHook; chain: ReturnType<MockHook["asChain"]>; deps: ApiDependencies; app: ReturnType<typeof createApiApp>;
  seedGear(symbol: string, o?: SeedGear): Promise<void>; seedIndexer(ageMs?: number): Promise<void>; close(): Promise<void>;
}
export interface SeedGear { sigmaBps?: number; sigmaAgeSec?: number; toll?: bigint; session?: string; fresh?: boolean; valueWad?: bigint; supply?: bigint }

export async function harness(label: string, o: { chain?: Partial<ApiChain>; now?: Date; config?: Record<string, string>; gearOver?: Partial<MockGear>; book?: Partial<MockBook> } = {}): Promise<Harness | undefined> {
  const db = await createTestDatabase(label);
  if (!db) return undefined;
  await applyMigrations(db);
  const deployment = apiDeployment();
  const hook = mockHookFor(deployment, o.gearOver, o.book);
  const chain = hook.asChain(o.chain);
  const now = o.now ?? new Date();
  const url = new URL(testDatabaseUrl()!);
  url.pathname = `/${db.name}`;
  const apiSql = createApiSql(url.toString()); // a plain client, as the API gets in production (dates parse as Date)
  const deps: ApiDependencies = { sql: apiSql, config: testConfig(o.config), deployment, logger: pino({ level: "silent" }), cache: new TtlCache(), chain, now: () => now };
  const app = createApiApp(deps);
  const sql = db.sql;
  return {
    db, sql: apiSql, raw: sql, deployment, hook, chain, deps, app,
    async seedGear(symbol, s = {}) {
      const g = deployment.gears.find((x) => x.symbol === symbol)!;
      const powerWad = POWERS.find((p) => p.power === g.power)!.powerWad;
      const underlying = g.marketB ? `${g.marketA}/${g.marketB}` : g.marketA;
      // a pair gear row carries the on-chain bytes32 market ids, as the indexer stores them; its sigma lives under the oracle pair key
      const ascii32 = (s: string) => `0x${Buffer.from(s).toString("hex").padEnd(64, "0")}` as `0x${string}`;
      const marketA = g.marketB ? ascii32(g.marketA) : g.marketA;
      const marketB = g.marketB ? ascii32(g.marketB) : null;
      const volKey = marketB ? pairMarketKey(marketA as `0x${string}`, marketB) : underlying;
      await sql`INSERT INTO gears (id, market_a, market_b, underlying, underlying_b, power, power_wad, token, cap_usd, spread_bps, status)
        VALUES (${g.id}, ${marketA}, ${marketB}, ${underlying}, ${g.marketB}, ${g.power}, ${powerWad.toString()}, ${g.token.toLowerCase()}, ${g.capUsd}, ${g.spreadBps}, 'active') ON CONFLICT DO NOTHING`;
      await sql`INSERT INTO prices (underlying, ts, block, price_wad, session, fresh) VALUES (${underlying}, ${now.toISOString()}, 1, ${(250n * WAD).toString()}, ${s.session ?? "OPEN"}, ${s.fresh ?? true}) ON CONFLICT DO NOTHING`;
      if (s.sigmaBps !== undefined) {
        const at = new Date(now.getTime() - (s.sigmaAgeSec ?? 60) * 1000);
        await sql`INSERT INTO vol_posts (gear_or_underlying, ts, block, tx_hash, log_index, sigma_bps) VALUES (${volKey}, ${at.toISOString()}, 1, ${idOf(`vp-${symbol}`)}, 0, ${s.sigmaBps}) ON CONFLICT DO NOTHING`;
      }
      if (s.toll !== undefined) await sql`INSERT INTO nf_history (gear, ts, block, tx_hash, log_index, nf, toll) VALUES (${g.id}, ${now.toISOString()}, 1, ${idOf(`nf-${symbol}`)}, 0, ${WAD.toString()}, ${s.toll.toString()}) ON CONFLICT DO NOTHING`;
      if (s.valueWad !== undefined) await sql`INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, side, tokens, usdg, value_per_token, via) VALUES (${idOf(`tr-${symbol}`)}, 0, 1, ${now.toISOString()}, ${g.id}, ${addr("a")}, 'buy', 1, 1, ${s.valueWad.toString()}, 'hook') ON CONFLICT DO NOTHING`;
      if (s.supply !== undefined) await sql`INSERT INTO balances (token, account, balance) VALUES (${g.token.toLowerCase()}, ${addr("holder")}, ${s.supply.toString()}) ON CONFLICT (token, account) DO UPDATE SET balance = EXCLUDED.balance`;
    },
    async seedIndexer(ageMs = 0) {
      const at = new Date(now.getTime() - ageMs).toISOString();
      await sql`INSERT INTO cursors (name, block, updated_at) VALUES ('main', 1234, ${at}) ON CONFLICT (name) DO UPDATE SET block = 1234, updated_at = ${at}`;
      await sql`INSERT INTO service_status (job, last_run, last_ok, meta) VALUES ('indexer', ${at}, ${at}, ${JSON.stringify({ lag: "0", snapshotStale: false })}::jsonb) ON CONFLICT (job) DO UPDATE SET last_ok = ${at}, meta = EXCLUDED.meta`;
    },
    close: async () => { await apiSql.end({ timeout: 2 }); await db.close(); },
  };
}
