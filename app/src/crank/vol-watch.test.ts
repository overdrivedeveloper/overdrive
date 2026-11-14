import { beforeEach, describe, expect, test } from "bun:test";
import { FakeChain, MARKET_ETH, MARKET_TSLA, nullSql } from "../testing/mock-chain";
import { resetAlertMemory, setAlertSender, type Alert } from "./alerts";
import { createVolWatchJob } from "./jobs/vol-watch";

describe("vol-watch", () => {
  let chain: FakeChain;
  const alerts: Alert[] = [];
  beforeEach(() => {
    chain = new FakeChain();
    alerts.length = 0;
    resetAlertMemory();
    setAlertSender(async (a) => { alerts.push(a); });
  });

  test("stale_warns_only_hard_stale_is_critical", async () => {
    const now = chain.nowSeconds;
    chain.vol.set(MARKET_TSLA, { sigmaBps: 4500n, postedAt: now - 8000n, validUntil: now - 600n, stale: true, hardStale: false });
    chain.vol.set(MARKET_ETH, { sigmaBps: 6000n, postedAt: now - 200_000n, validUntil: now - 190_000n, stale: true, hardStale: true });
    const job = createVolWatchJob(chain.context(nullSql));
    // TSLA is stale for 600 s: under the 900 s warning delay, ETH is hard stale
    let result = await job();
    expect(result.warned).toEqual([]);
    expect(result.critical).toEqual(["ETH"]);
    expect(alerts.map((a) => [a.key, a.level])).toEqual([["vol:hard:ETH", "critical"]]);
    // 400 s later TSLA has been stale for 1000 s: a warning, still no pause (the job never sends a transaction)
    chain.warp(400);
    result = await job();
    expect(result.warned).toEqual(["TSLA"]);
    expect(alerts.find((a) => a.key === "vol:stale:TSLA")!.level).toBe("warn");
    expect(chain.sent.length).toBe(0);
    // a fresh post clears it
    chain.vol.set(MARKET_TSLA, { sigmaBps: 4500n, postedAt: chain.nowSeconds, validUntil: chain.nowSeconds + 7200n, stale: false, hardStale: false });
    expect((await job()).stale).toEqual(["ETH"]);
  });
});
