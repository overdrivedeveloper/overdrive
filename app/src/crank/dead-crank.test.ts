// R11 (KEEP-6): with the crank never started, every state it normally maintains still has a permissionless way out. The mock chain
// enforces no roles on the permissionless functions (as the contracts do), so each state is brought up with NO crank pass at all
// and cleared by an arbitrary caller; the contract-level proof of the fallback calendar and the min(lastValue, poolValue) sell
// is in todo 02a/05b and the fork run (22).
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, keccak256, toHex } from "viem";
import { IODMarketHoursAbi, IODMinterAbi, IODOracleGuardAbi } from "../abi";
import { FakeChain, MARKET_ETH, MARKET_TSLA, WAD } from "../testing/mock-chain";

const STRANGER = "0x00000000000000000000000000000000000000ff";
const abiHas = (abi: readonly { type: string; name?: string; stateMutability?: string }[], name: string) => abi.some((i) => i.type === "function" && i.name === name);

describe("dead crank", () => {
  test("every_state_has_a_permissionless_path", () => {
    const chain = new FakeChain();
    chain.nowSeconds = BigInt(Date.parse("2026-11-17T15:00:00Z") / 1000);
    const id = keccak256(toHex("g"));
    chain.addGear({ id, marketA: MARKET_TSLA, lastAccrual: chain.nowSeconds - 3n * 86_400n });
    chain.addMarketPrice(MARKET_TSLA, { updatedAt: chain.nowSeconds - 3n * 86_400n });
    chain.addMarketPrice(MARKET_ETH);
    const minter = chain.deployment.contracts.ODMinter as `0x${string}`;
    const guard = chain.deployment.contracts.ODOracleGuard as `0x${string}`;
    const sent = () => chain.sent.length;

    // 1. never accrued: three days of toll are owed, and anyone can settle it with accrue / accrueMany
    expect(chain.gears.get(id)!.lastAccrual).toBeLessThan(chain.nowSeconds);
    chain.gears.get(id)!.tollPerSecWad = 1_000n;
    chain.execute(minter, encodeFunctionData({ abi: IODMinterAbi, functionName: "accrue", args: [id] }), true, STRANGER);
    expect(chain.gears.get(id)!.lastAccrual).toBe(chain.nowSeconds);
    expect(chain.gears.get(id)!.nf).toBeLessThan(WAD);
    chain.warp(1000);
    chain.execute(minter, encodeFunctionData({ abi: IODMinterAbi, functionName: "accrueMany", args: [[id]] }), true, STRANGER);
    expect(chain.gears.get(id)!.lastAccrual).toBe(chain.nowSeconds);

    // 2. never fed sessions: the calendar is empty, so reads fall to the contract's own calendar (fallbackEnabled / kindAt) and the
    //    state never needs the KEEPER role to be safe; the only pusher is the crank, and the fallback is the dead-crank answer
    expect(chain.sessions).toEqual([]);
    expect(abiHas(IODMarketHoursAbi, "fallbackEnabled")).toBe(true);
    expect(abiHas(IODMarketHoursAbi, "kindAt")).toBe(true);
    expect(chain.read(chain.deployment.contracts.ODMarketHours as `0x${string}`, "kindAt", [chain.nowSeconds])).toBeDefined();

    // 3. never poked: the guard's lastGood and halt latch are stale, and poke(market) is open to anyone
    chain.execute(guard, encodeFunctionData({ abi: IODOracleGuardAbi, functionName: "poke", args: [MARKET_TSLA] }), true, STRANGER);
    expect(chain.prices.get(MARKET_TSLA)!.updatedAt).toBe(chain.nowSeconds);

    // 4. never settled queue: a queued sell can be filled by anyone and cancelled by its owner
    chain.mutators.set("ODMinter.fillQueued", () => 120_000n);
    chain.execute(minter, encodeFunctionData({ abi: IODMinterAbi, functionName: "fillQueued", args: [1n] }), true, STRANGER);
    expect(abiHas(IODMinterAbi, "cancelQueued")).toBe(true);

    // 5. sells never wait for the crank: sell pays now or queueSell escrows; quote reports which
    expect(abiHas(IODMinterAbi, "sell")).toBe(true);
    expect(abiHas(IODMinterAbi, "queueSell")).toBe(true);
    const quote = IODMinterAbi.find((x) => x.type === "function" && x.name === "quote")!;
    expect(JSON.stringify(quote.outputs)).toContain("queued");

    // the crank was never started: nothing was sent through its queue, and every call above was a stranger's
    expect(sent()).toBe(0);
    void decodeFunctionData;
  });
});
