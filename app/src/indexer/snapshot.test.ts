import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { computeLedger, takeSnapshot } from "./snapshot";
import { fakeReader, GEAR_1, GEAR_2, listGear, MARKET_NVDA, MARKET_TSLA, FakeChain, drain, newState, TOKEN_1, TOKEN_2, testDeployment } from "./test-support";
import { WAD } from "../lib/fixed";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();
const usdg = (v: number) => BigInt(Math.round(v * 1e6));
const wad = (v: number) => BigInt(Math.round(v * 1e6)) * 10n ** 12n;

describe("ledger formula", () => {
  test("delta sums p*V and gamma p(p-1)*V; a pair adds -p*V and p(p+1)*V on the second leg", () => {
    const symbol = (m: string) => (m === "A" ? "TSLA" : "NVDA");
    const rows = computeLedger([
      { marketA: "A", marketB: null, powerWad: 3n * WAD, holderTokens: 100n * WAD, valuePerTokenWad: 2n * WAD },
      { marketA: "A", marketB: "B", powerWad: 2n * WAD, holderTokens: 50n * WAD, valuePerTokenWad: 1n * WAD },
    ], symbol);
    const tsla = rows.find((r) => r.underlying === "TSLA")!;
    const nvda = rows.find((r) => r.underlying === "NVDA")!;
    // V1 = 200, V2 = 50; delta A = 3*200 + 2*50 = 700; gamma A = 3*2*200 + 2*1*50 = 1300
    expect(tsla.deltaUsdg).toBe(usdg(700));
    expect(tsla.gammaUsdg).toBe(usdg(1300));
    // B: delta -2*50 = -100; gamma p(p+1) V = 2*3*50 = 300
    expect(nvda.deltaUsdg).toBe(usdg(-100));
    expect(nvda.gammaUsdg).toBe(usdg(300));
  });
});

suite("snapshot", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("snapshot"))!;
    await applyMigrations(db);
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1, 0), listGear(d, GEAR_2, MARKET_TSLA, TOKEN_2, 1)]);
    await drain(await newState(db.sql, chain));
    await db.sql`DELETE FROM governor_ledger; DELETE FROM prices; DELETE FROM exit_reserve_log`.simple();
  });
  afterAll(async () => db.close());

  test("ledger_matches_chain_getter_and_formula", async () => {
    // fixture chain getter: exposure(market) for TSLA computed by the contract's own definition
    const supply = 1000n * WAD, debt = 200n * WAD, value = 2n * WAD;
    const holders = supply - debt;
    const v = (holders * value) / WAD; // WAD USD
    const chainDelta = (1_500_000_000_000_000_000n * v) / WAD + (2n * WAD * v) / WAD;
    const chainGamma = (((1_500_000_000_000_000_000n * (1_500_000_000_000_000_000n - WAD)) / WAD) * v) / WAD + (((2n * WAD * (2n * WAD - WAD)) / WAD) * v) / WAD;
    const at = { block: 9n, ts: new Date(1_700_000_000_000) };
    const result = await takeSnapshot(fakeReader(), db.sql, d, at);
    expect(result).toEqual({ ok: true, ledgerRows: 1 });
    const row = (await db.sql`SELECT delta, gamma, equity, exit_reserve FROM governor_ledger WHERE underlying = 'TSLA'`)[0]!;
    expect(BigInt(row.delta) - chainDelta / 10n ** 12n).toBeLessThanOrEqual(1n);
    expect(chainDelta / 10n ** 12n - BigInt(row.delta)).toBeLessThanOrEqual(1n);
    expect(BigInt(row.gamma) - chainGamma / 10n ** 12n).toBeLessThanOrEqual(1n);
    expect(chainGamma / 10n ** 12n - BigInt(row.gamma)).toBeLessThanOrEqual(1n);
    expect(row.equity).toBe("5000000");
    expect((await db.sql`SELECT price_wad, fresh, multiplier_wad FROM prices WHERE underlying = 'TSLA'`)[0]).toEqual({ price_wad: (250n * WAD).toString(), fresh: true, multiplier_wad: WAD.toString() });
    expect((await db.sql`SELECT multiplier_wad FROM prices WHERE underlying = 'NVDA'`)[0]!.multiplier_wad).toBeNull();
    expect((await db.sql`SELECT "floor" FROM exit_reserve_log`)[0]!.floor).toBe("500000");
    expect(MARKET_NVDA.length).toBe(66);
  });

  test("failed_read_keeps_previous_and_flags", async () => {
    const before = await db.sql`SELECT ts, delta FROM governor_ledger`;
    const failing = fakeReader({ governor: async () => { throw new Error("rpc 503"); } });
    const result = await takeSnapshot(failing, db.sql, d, { block: 10n, ts: new Date(1_700_000_600_000) });
    expect(result.ok).toBe(false);
    expect([...(await db.sql`SELECT ts, delta FROM governor_ledger`)]).toEqual([...before]); // no new row, no zeros
    const status = (await db.sql`SELECT meta, last_error FROM service_status WHERE job = 'indexer'`)[0]!;
    expect(status.meta.snapshotStale).toBe(true);
    expect(status.last_error).toContain("snapshot failed");
    // a later good snapshot clears the flag
    await takeSnapshot(fakeReader(), db.sql, d, { block: 11n, ts: new Date(1_700_001_200_000) });
    expect((await db.sql`SELECT meta FROM service_status WHERE job = 'indexer'`)[0]!.meta.snapshotStale).toBe(false);
    expect(wad(1)).toBe(WAD);
  });
});
