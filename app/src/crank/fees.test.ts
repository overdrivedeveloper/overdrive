import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { IODFeesAbi } from "../abi";
import { RevertError } from "../chain/revert";
import { FakeChain, nullSql } from "../testing/mock-chain";
import { createFeesJob } from "./jobs/fees";

describe("fees", () => {
  let chain: FakeChain;
  let next = 0n, amount = 0n;
  beforeEach(() => {
    chain = new FakeChain();
    chain.nowSeconds = 1_800_000_000n;
    chain.readers.set("ODFees.nextDistributionAt", () => next);
    chain.readers.set("ODFees.distributable", () => amount);
  });
  const distributed = (split: bigint[]) => {
    const fees = chain.deployment.contracts.ODFees as `0x${string}`;
    chain.pendingLogs.push({
      address: fees,
      topics: encodeEventTopics({ abi: IODFeesAbi, eventName: "Distributed" }) as `0x${string}`[],
      data: encodeAbiParameters(IODFeesAbi.find((x) => x.type === "event" && x.name === "Distributed")!.inputs, split as never),
    });
  };

  test("calls_when_due_reads_split_from_event_and_treats_too_early_as_skip", async () => {
    const job = createFeesJob(chain.context(nullSql, { FEES_MIN_USDG: "50" }));
    // not due yet
    next = chain.nowSeconds + 100n; amount = 1_000_000_000n;
    expect(await job()).toMatchObject({ idle: true, reason: "not_due" });
    // due but under the minimum (50 USDG = 50,000,000 raw)
    next = chain.nowSeconds - 1n; amount = 49_000_000n;
    expect(await job()).toMatchObject({ idle: true, reason: "below_min" });
    expect(chain.sent.length).toBe(0);
    // due and above the minimum: distributes, and reports the split the CONTRACT emitted (not 80/10/5/5)
    amount = 200_000_000n;
    chain.mutators.set("ODFees.distribute", () => { distributed([200n, 100n, 20n, 10n, 30n, 30n, 5n, 5n]); return 150_000n; });
    const done = await job();
    expect(done).toMatchObject({ idle: false, split: { amount: "200", toGovernor: "100", toExitReserve: "20", toKeepers: "10", toHedgers: "30", toTreasury: "30", toStakers: "5", toBurn: "5" } });
    expect(chain.sent.map((s) => s.name)).toEqual(["distribute"]);
    // someone else distributed first: TooEarly is a skip, not an error
    chain.mutators.set("ODFees.distribute", () => { throw new RevertError({ name: "TooEarly", args: [1n], signature: "0x" }, undefined); });
    expect(await job()).toMatchObject({ idle: true, reason: "too_early" });
    // any other revert is an error the scheduler retries
    chain.mutators.set("ODFees.distribute", () => { throw new RevertError({ name: "InvalidParams", args: [], signature: "0x" }, undefined); });
    await expect(job()).rejects.toThrow("InvalidParams");
  });
});
