import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Abi } from "viem";
import { IODBackerAbi, IODOracleGuardAbi } from "../abi";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { accrued, addressOf, bought, collateralMoved, drain, ev, FakeChain, feeNotified, GEAR_1, GEAR_2, listGear, MARKET_TSLA, newState, queueFilled, resetDb, sellQueued, STOCK_TSLA, TOKEN_1, TOKEN_2, transfer, testDeployment, USERS, vaultMinted, vaultOpened, volPosted, ZERO } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const d = testDeployment();

suite("handlers", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("handlers"))!; await applyMigrations(db); });
  afterAll(async () => db.close());

  test("nf_equals_latest_history", async () => {
    await resetDb(db.sql);
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1)]);
    expect((await (async () => { await drain(await newState(db.sql, chain)); return db.sql`SELECT nf FROM gears`; })())[0]!.nf).toBe("1000000000000000000");
    chain.add([accrued(d, GEAR_1, 999n * 10n ** 15n), accrued(d, GEAR_1, 998n * 10n ** 15n)]);
    chain.add([accrued(d, GEAR_1, 997n * 10n ** 15n)]);
    await drain(await newState(db.sql, chain));
    const gear = (await db.sql`SELECT nf, last_accrual FROM gears`)[0]!;
    const latest = (await db.sql`SELECT nf, ts FROM nf_history ORDER BY block DESC, log_index DESC LIMIT 1`)[0]!;
    expect(gear.nf).toBe(latest.nf);
    expect(gear.nf).toBe("997000000000000000");
    expect(new Date(gear.last_accrual).getTime()).toBe(new Date(latest.ts).getTime());
  });

  test("split_event_recorded_with_effective_time", async () => {
    await resetDb(db.sql);
    const chain = new FakeChain();
    const effective = 1_700_100_000n;
    chain.add([ev(STOCK_TSLA, [{ type: "event", name: "UIMultiplierUpdated", inputs: [{ name: "oldMultiplier", type: "uint256", indexed: false }, { name: "newMultiplier", type: "uint256", indexed: false }, { name: "effectiveAtTimestamp", type: "uint256", indexed: false }] }] as Abi,
      "UIMultiplierUpdated", { oldMultiplier: 10n ** 18n, newMultiplier: 2n * 10n ** 18n, effectiveAtTimestamp: effective })]);
    await drain(await newState(db.sql, chain));
    const rows = await db.sql`SELECT kind, old_wad, new_wad, effective_at, token FROM stock_events`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("ui_multiplier");
    expect(rows[0]!.new_wad).toBe("2000000000000000000");
    expect(new Date(rows[0]!.effective_at).getTime()).toBe(Number(effective) * 1000);
    // the snapshot records the multiplier used for the oracle read (not yet effective: 1e18; effective: 2e18)
    expect((await db.sql`SELECT multiplier_wad FROM prices WHERE underlying = 'TSLA'`)[0]!.multiplier_wad).toBe("1000000000000000000");
  });

  test("trades, queue, vaults, fees, oracle and admin events land in their tables", async () => {
    await resetDb(db.sql);
    const chain = new FakeChain();
    chain.add([listGear(d, GEAR_1, MARKET_TSLA, TOKEN_1, 0), listGear(d, GEAR_2, MARKET_TSLA, TOKEN_2, 4)]);
    chain.add([transfer(TOKEN_1, ZERO, USERS[0]!, 100n), bought(d, GEAR_1, USERS[0]!, 50n, 100n, true), sellQueued(d, 7n, GEAR_1, USERS[0]!, 40n), feeNotified(d, 9n)]);
    chain.add([queueFilled(d, 7n), volPosted(d, MARKET_TSLA, 4500n, 1_800_000_000n), accrued(d, GEAR_1, 9n * 10n ** 17n, 100n)]);
    chain.add([vaultOpened(d, 1n, USERS[1]!, GEAR_2), collateralMoved(d, 1n, 500n, 500n), vaultMinted(d, 1n, 30n),
      ev(addressOf(d, "ODOracleGuard"), IODOracleGuardAbi as Abi, "BuysPausedSet", { market: MARKET_TSLA, paused: true, reason: `0x${Buffer.from("MANUAL").toString("hex").padEnd(64, "0")}` }),
      ev(addressOf(d, "ODBacker"), IODBackerAbi as Abi, "BatchSealed", { batchId: 5n, gearId: GEAR_2, sealedValueWad: 10n ** 18n, sealedAt: 1n, vaultIds: [1n] }),
      ev(addressOf(d, "ODBacker"), IODBackerAbi as Abi, "Liquidated", { batchId: 5n, vaultId: 1n, debtTokens: 30n, collateralSeized: 200n, bonusUsdg: 10n, badDebtUsdg: 0n })]);
    await drain(await newState(db.sql, chain));
    const gears = await db.sql`SELECT underlying, power, power_wad, status, cap_usd FROM gears ORDER BY power_wad DESC`;
    expect(gears.map((g) => [g.underlying, g.power])).toEqual([["TSLA", "1.5"], ["TSLA", "-1"]]);
    expect((await db.sql`SELECT side, via, tokens, usdg FROM trades ORDER BY block, log_index`).map((t) => [t.side, t.via])).toEqual([["buy", "hook"], ["sell", "queue"]]);
    expect((await db.sql`SELECT status FROM queued_sells`)[0]!.status).toBe("filled");
    expect((await db.sql`SELECT kind, amount FROM fees`)[0]).toEqual({ kind: "toll", amount: "9" });
    expect((await db.sql`SELECT sigma_hat, usage FROM nf_history`)[0]!.sigma_hat).toBe((4500n * 10n ** 14n).toString());
    expect((await db.sql`SELECT scope, action, reason FROM pause_log`)[0]).toEqual({ scope: "underlying", action: "pause", reason: "MANUAL" });
    const vault = (await db.sql`SELECT collateral, debt_tokens, status FROM backer_vaults`)[0]!;
    expect(vault).toEqual({ collateral: "300", debt_tokens: "0", status: "closed" });
    expect((await db.sql`SELECT status FROM liquidation_batches`)[0]!.status).toBe("executed");
    expect((await db.sql`SELECT bonus_usdg FROM liquidations`)[0]!.bonus_usdg).toBe("10");
    expect((await db.sql`SELECT balance FROM balances`)[0]!.balance).toBe("100");
  });
});
