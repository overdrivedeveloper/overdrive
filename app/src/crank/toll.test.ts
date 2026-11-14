import { beforeEach, describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { FakeChain, MARKET_ETH, MARKET_TSLA, WAD, nullSql } from "../testing/mock-chain";
import { createTollJob, nearBoundary } from "./jobs/toll";

const gid = (n: number): Hex => keccak256(toHex(`gear-${n}`));
// 2026-11-17 (Tuesday) 15:00Z = 10:00 ET, inside the regular session; regular open that day is 14:30Z
const TUESDAY_10AM_ET = BigInt(Date.parse("2026-11-17T15:00:00Z") / 1000);
let chain: FakeChain;
beforeEach(() => { chain = new FakeChain(); chain.nowSeconds = TUESDAY_10AM_ET; });
const job = (overrides: Record<string, string> = {}) => createTollJob(chain.context(nullSql, overrides));
const accrueCalls = () => chain.sent.filter((s) => s.name === "accrueMany");

describe("toll", () => {
  test("accrues_only_gears_older_than_max_age", async () => {
    chain.addGear({ id: gid(1), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n });
    chain.addGear({ id: gid(2), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 100n });
    const result = await job()();
    expect(result.accrued).toBe(1);
    expect(result.skipped.not_due).toBe(1);
    expect(chain.gears.get(gid(1))!.lastAccrual).toBe(chain.nowSeconds);
  });

  test("boundary_forces_accrual", async () => {
    // a TSLA gear accrued 200 s ago is not due by age; 20 s before the regular open (14:30Z) it is forced, ETH is not
    chain.nowSeconds = BigInt(Date.parse("2026-11-17T14:29:40Z") / 1000);
    chain.addGear({ id: gid(1), marketA: MARKET_TSLA, lastAccrual: chain.nowSeconds - 200n });
    chain.addGear({ id: gid(2), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 200n });
    expect(nearBoundary(Number(chain.nowSeconds) * 1000)).toBe(true);
    const near = await job()();
    expect(near.accrued).toBe(1);
    expect(near.boundaryForced).toBe(1);
    expect(accrueCalls()[0]!.args[0]).toEqual([gid(1)]);
    // the stored rate of the old interval was applied up to the boundary
    expect(chain.gears.get(gid(1))!.lastAccrual).toBe(chain.nowSeconds);
    // 10 minutes later no boundary is near: a young gear is left alone
    chain.sent.length = 0;
    chain.warp(600);
    const later = await job()();
    expect(later.accrued).toBe(0);
    // the explicit boundary poke forces it too
    const forced = await job()(true);
    expect(forced.accrued).toBe(1);
  });

  test("zero_supply_skipped", async () => {
    chain.addGear({ id: gid(1), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n, supply: 0n });
    const run = job();
    const first = await run();
    expect(first.accrued).toBe(0);
    expect(first.skipped.zero_supply).toBe(1);
    chain.reads = 0;
    const second = await run();
    expect(second.skipped.zero_supply).toBe(1);
    // remembered: the second pass did not read totalSupply again (gearCount + one multicall of gear and normState only)
    const supplyReads = chain.reads;
    expect(supplyReads).toBeLessThanOrEqual(4);
    // after a mint the gear's lastAccrual moves, so it is looked at again
    chain.gears.get(gid(1))!.supply = 5n * WAD;
    chain.gears.get(gid(1))!.lastAccrual = chain.nowSeconds - 5000n;
    expect((await run()).accrued).toBe(1);
  });

  test("failed_batch_splits", async () => {
    for (let i = 0; i < 40; i++) chain.addGear({ id: gid(i), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n });
    // only 12 gears fit per transaction at 90k per gear
    chain.gasLimit = 60_000n + 90_000n * 12n;
    const result = await job({ CRANK_TOLL_BATCH: "40" })();
    expect(result.accrued).toBe(40);
    expect(Object.keys(result.skipped).filter((k) => k.startsWith("revert"))).toEqual([]);
    for (const call of accrueCalls()) expect((call.args[0] as Hex[]).length).toBeLessThanOrEqual(12);
    expect([...chain.gears.values()].every((g) => g.lastAccrual === chain.nowSeconds)).toBe(true);
  });

  test("one_bad_gear_does_not_block_others", async () => {
    // the bad gear sorts first
    chain.addGear({ id: gid(0), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n, revertName: "FeedPaused" });
    for (let i = 1; i < 9; i++) chain.addGear({ id: gid(i), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n });
    const result = await job()();
    expect(result.accrued).toBe(8);
    expect(result.skipped["revert:FeedPaused"]).toBe(1);
    expect(chain.gears.get(gid(0))!.lastAccrual).toBe(chain.nowSeconds - 4000n);
    for (let i = 1; i < 9; i++) expect(chain.gears.get(gid(i))!.lastAccrual).toBe(chain.nowSeconds);
  });

  test("dry_run_records_simulated", async () => {
    chain.dryRun = true;
    chain.addGear({ id: gid(1), marketA: MARKET_ETH, lastAccrual: chain.nowSeconds - 4000n });
    const result = await job()();
    expect(result.dryRun).toBe(true);
    expect(chain.gears.get(gid(1))!.lastAccrual).toBe(chain.nowSeconds - 4000n);
  });
});
