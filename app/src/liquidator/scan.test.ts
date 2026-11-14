import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { testDatabaseUrl, type TestDatabase } from "../testing/db";
import { GEAR_TSLA } from "../testing/mock-backer";
import { WAD } from "../testing/mock-chain";
import { scanCandidates, scanWithReport } from "./scan";
import { harness, liquidatorDb, resetTables } from "./test-harness";

const U = 10n ** 6n;
const suite = testDatabaseUrl() ? describe : describe.skip;

suite("scan (R10)", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await liquidatorDb("liqscan"); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await resetTables(db.sql); });

  test("flood_of_dust_does_not_starve_deep_shortfall", async () => {
    const h = harness(db.sql, { maxVaultsPerBatch: 20, scanLimit: 50, passSeconds: 120 });
    // 500 dust backers just under maintenance, opened first (lower ids), and one deep shortfall opened last
    for (let i = 0; i < 500; i++) h.backer.openVault(GEAR_TSLA, 1_490_000n, WAD);
    const deep = h.backer.openVault(GEAR_TSLA, 100n * U, 1000n * WAD);
    await h.index();
    const c = await scanCandidates(db.sql, { limit: 50, maxIndexAgeS: 300 });
    expect(c).toHaveLength(50);
    expect(c[0]!.vaultId).toBe(deep);
    // the pass seals the deep one; the dust waits and is listed
    h.backer.gasPriceWei = 10n ** 9n;
    const p = await h.pass();
    expect(p.sealed).toBe("1");
    expect(h.backer.batches.get(1n)!.vaultIds).toEqual([deep]);
    expect(p.uneconomic.length).toBeGreaterThan(0);
    expect(p.uneconomic).not.toContain(deep.toString());
    const listed = await db.sql<{ n: number }[]>`select count(*)::int as n from liquidation_attempts where verdict = 'uneconomic'`;
    expect(listed[0]!.n).toBe(p.uneconomic.length);
  });

  test("malformed_rows_reported_not_thrown", async () => {
    await db.sql`insert into backer_vaults (id, owner, gear, collateral, debt_tokens, status) values (1, 'x', 'not-a-gear', 1, 1, 'open'), (2, 'x', ${GEAR_TSLA}, 1, 1, 'open'), (3, 'x', ${GEAR_TSLA}, 1, 0, 'open'), (4, 'x', ${GEAR_TSLA}, 1, 1, 'closed')`;
    const r = await scanWithReport(db.sql, { limit: 10, maxIndexAgeS: 300 });
    expect(r.candidates.map((c) => c.vaultId)).toEqual([2n]);
    expect(r.malformed.map((m) => m.id)).toEqual(["1"]);
  });
});
