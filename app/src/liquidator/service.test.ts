import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetAlertMemory } from "../crank/alerts";
import { acquireServiceLock } from "../lib/jobs";
import { testDatabaseUrl, type TestDatabase } from "../testing/db";
import { GEAR_TSLA } from "../testing/mock-backer";
import { WAD, logger } from "../testing/mock-chain";
import { harness, liquidatorDb, resetTables } from "./test-harness";

const U = 10n ** 6n;
const suite = testDatabaseUrl() ? describe : describe.skip;

suite("liquidation service", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await liquidatorDb("liqsvc"); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await resetTables(db.sql); resetAlertMemory(); });
  const runs = () => db.sql<{ batch_id: string | null; phase: string; error: string | null; bonus_usdg: string | null; bad_debt_usdg: string | null; covered_usdg: string | null; vault_ids: string[] }[]>`
    select batch_id::text, phase, error, bonus_usdg::text, bad_debt_usdg::text, covered_usdg::text, vault_ids::text[] from liquidation_runs order by id`;

  test("seal_wait_execute_order", async () => {
    const h = harness(db.sql, { passSeconds: 10 });
    const a = h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    await h.index();
    const first = await h.pass();
    expect(first.sealed).toBe("1");
    expect(first.executed).toEqual([]);
    // batchWindow(batchId).readyAt (sealedAt + SEAL_DELAY = 30 s) is longer than a pass: the scheduler comes back then,
    // without sending a doomed executeBatch
    expect(first.retryAfterMs).toBe(30_000);
    expect(h.calls()).toEqual([`sealBatch(${GEAR_TSLA},${a})`]);
    h.chain.warp(31);
    const second = await h.pass();
    expect(second.executed).toEqual(["1"]);
    expect(h.calls()).toEqual([`sealBatch(${GEAR_TSLA},${a})`, "executeBatch(1)"]);
    expect((await runs()).map((r) => r.phase)).toEqual(["executed"]);
    // a wait shorter than a pass is slept through inside the same pass
    const h2 = harness(db.sql, { passSeconds: 120 });
    await resetTables(db.sql);
    h2.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    await h2.index();
    const one = await h2.pass();
    expect([one.sealed, one.executed]).toEqual(["1", ["1"]]);
    expect(h2.calls().map((c) => c.split("(")[0])).toEqual(["sealBatch", "executeBatch"]);
  });

  test("voided_or_expired_batch_reverified_not_resealed", async () => {
    const h = harness(db.sql, { passSeconds: 10 }) // SEAL_DELAY (30 s) longer than a pass;
    const a = h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    const b = h.backer.openVault(GEAR_TSLA, 110n * U, 100n * WAD);
    await h.index();
    expect((await h.pass()).sealed).toBe("1");
    // the window passes; meanwhile b's backer tops up
    h.chain.warp(60 + 900 + 1);
    h.backer.vaults.get(b)!.collateralUsdg = 300n * U;
    const p = await h.pass();
    expect(p.voided).toEqual(["1"]);
    // re-verified: b is healthy and is not sealed again; a still is under water and gets a NEW batch after a fresh chain read
    expect(p.sealed).toBe("2");
    expect(h.backer.batches.get(2n)!.vaultIds).toEqual([a]);
    const rows = await runs();
    expect(rows[0]).toMatchObject({ batch_id: "1", phase: "voided", error: "expired before execution" });
    const verdicts = await db.sql<{ verdict: string }[]>`select verdict from liquidation_attempts where vault_id = ${b.toString()} order by ts desc limit 1`;
    expect(verdicts[0]!.verdict).toBe("recovered");
    // a voided batch: recorded with the contract's reason
    h.chain.warp(61);
    h.backer.voidNext = "PRICE_DOUBT";
    const q = await h.pass();
    expect(q.voided).toEqual(["2"]);
    expect((await runs()).find((r) => r.batch_id === "2")).toMatchObject({ phase: "voided", error: "voided: PRICE_DOUBT" });
  });

  test("execute_margin_lets_a_batch_lapse", async () => {
    // LIQUIDATOR_EXECUTE_MARGIN_SECONDS (60): inside the last minute of BATCH_TTL no executeBatch is sent
    const h = harness(db.sql, { executeMarginSeconds: 60 });
    const v = h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    h.backer.sealAsOther(GEAR_TSLA, [v]);
    await h.index();
    h.chain.warp(900 - 30);
    const p = await h.pass();
    expect(p.executed).toEqual([]);
    expect(h.calls().filter((c) => c.startsWith("executeBatch"))).toEqual([]);
    expect(h.state.open.has(1n)).toBe(true);
    expect(h.backer.readCount.get("batchWindow")).toBeGreaterThan(0);
    h.chain.warp(31); // past sealedAt + BATCH_TTL: closed as expired, the vault is free again and re-verified
    const q = await h.pass();
    expect(q.voided).toEqual(["1"]);
    expect((await runs())[0]).toMatchObject({ batch_id: "1", phase: "voided", error: "expired before execution" });
  });

  test("restart_finds_open_batches_from_events", async () => {
    const h = harness(db.sql, { passSeconds: 10 });
    const done = h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    const open = h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    // history: batch 1 sealed and executed by someone else; batch 2 sealed by our previous process, then it crashed
    h.backer.sealAsOther(GEAR_TSLA, [done]);
    h.chain.warp(61);
    h.backer.executeAsOther(1n);
    h.backer.sealAsOther(GEAR_TSLA, [open]);
    await h.index();
    h.restart();
    h.chain.warp(10); // 20 s before it is ready: longer than a pass, so the pass does not wait
    const p = await h.pass();
    // the open batch came from events (the runs table is empty), its vault was not sealed again
    expect(h.state.open.has(2n)).toBe(true);
    expect(p.sealed).toBeUndefined();
    expect(h.calls().filter((c) => c.startsWith("sealBatch"))).toEqual([]);
    h.chain.warp(21);
    const q = await h.pass();
    expect(q.executed).toEqual(["2"]);
    expect(h.calls()).toEqual(["executeBatch(2)"]);
    expect((await runs()).map((r) => [r.batch_id, r.phase])).toEqual([["2", "executed"]]);
  });

  test("executed_by_other_is_not_an_error", async () => {
    const h = harness(db.sql, { passSeconds: 10 }) // SEAL_DELAY (30 s) longer than a pass;
    h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    await h.index();
    expect((await h.pass()).sealed).toBe("1");
    h.chain.warp(61);
    h.backer.executeAsOther(1n); // anyone can call: a faster liquidator took it
    const p = await h.pass();
    expect(p.executedByOther).toEqual(["1"]);
    expect(p.executed).toEqual([]);
    expect(h.calls().filter((c) => c.startsWith("executeBatch"))).toEqual([]);
    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ batch_id: "1", phase: "executed_by_other", error: null });
    const status = await db.sql<{ last_error: string | null }[]>`select last_error from service_status where job = 'liquidator'`;
    expect(status[0]!.last_error).toBeNull();
  });

  test("bad_debt_recorded_from_events_and_insurance_read_back", async () => {
    const h = harness(db.sql, { badDebtAlertUsdg: 10n * U, passSeconds: 120 });
    h.backer.openVault(GEAR_TSLA, 50n * U, 100n * WAD); // 50 USDG against 100 USD of debt
    h.backer.insuranceBalance = 30n * U;
    await h.index();
    const p = await h.pass();
    expect(p.executed).toEqual(["1"]);
    const liq = h.backer.logs.length;
    expect(liq).toBeGreaterThan(0);
    const [row] = await runs();
    // D 100, bonus 5 (5% of D): gap 55, insurance had 30; pool 80 = bonus 5 + Governor 75: bad debt 25
    expect(row).toMatchObject({ phase: "executed", bonus_usdg: "5000000", bad_debt_usdg: "25000000", covered_usdg: "30000000" });
    const alerts = await db.sql<{ meta: Record<string, { level: string; text: string }> }[]>`select meta from service_status where job = 'alerts'`;
    const alert = alerts[0]!.meta["liquidator:bad-debt:1"]!;
    expect(alert.level).toBe("critical");
    expect(alert.text).toContain("left 25 USDG");
    expect(alert.text).toContain("covered 30");
    // the number is the chain's: without a Covered event, nothing is claimed as covered
    await resetTables(db.sql);
    const h2 = harness(db.sql, { badDebtAlertUsdg: 10n * U, passSeconds: 120 });
    h2.backer.openVault(GEAR_TSLA, 50n * U, 100n * WAD);
    h2.backer.insuranceBalance = 0n;
    await h2.index();
    await h2.pass();
    expect((await runs())[0]).toMatchObject({ bonus_usdg: "5000000", bad_debt_usdg: "55000000", covered_usdg: "0" });
  });

  test("lock_and_status_heartbeat", async () => {
    const url = new URL(testDatabaseUrl()!);
    url.pathname = `/${db.name}`;
    const abort = new AbortController();
    const lock = await acquireServiceLock(url.toString(), "liquidator", logger, abort.signal, 50);
    expect(lock).toBeDefined();
    const other = new AbortController();
    setTimeout(() => other.abort(), 200);
    expect(await acquireServiceLock(url.toString(), "liquidator", logger, other.signal, 50)).toBeUndefined();
    const h = harness(db.sql, { passSeconds: 120 });
    h.backer.openVault(GEAR_TSLA, 100n * U, 100n * WAD);
    await h.index();
    await h.pass();
    const [s] = await db.sql<{ meta: Record<string, unknown>; last_ok: Date | null }[]>`select meta, last_ok from service_status where job = 'liquidator'`;
    expect(s!.last_ok).not.toBeNull();
    expect(s!.meta).toMatchObject({ openBatches: 0, dryRun: false });
    expect(BigInt(s!.meta.lastBonusUsdg as string)).toBeGreaterThan(0n);
    expect("scanAgeS" in s!.meta).toBe(true);
    // the queue is the shared one-nonce queue: nothing held after the pass
    expect(h.tx.status().heldNonce).toBeNull();
    await lock!.release();
  });
});
