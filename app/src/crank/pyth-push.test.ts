import { beforeEach, describe, expect, test } from "bun:test";
import { encodeFunctionData } from "viem";
import { RevertError } from "../chain/revert";
import { oracleOf } from "../api/routes/status";
import { authHeaderValue, fetchLatestUpdates, HermesError } from "./hermes";
import { checkReferences, createPythPushJob, PythAbi } from "./jobs/pyth-push";
import { resetAlertMemory } from "./alerts";
import { FakeChain, MARKET_ETH, MARKET_NVDA, MARKET_TSLA, nullSql } from "../testing/mock-chain";

const ETH_ID = `0x${"11".repeat(32)}` as const;
const NVDA_ID = `0x${"22".repeat(32)}` as const;
const BLOB = "0xdeadbeef" as const;

describe("pyth push", () => {
  let chain: FakeChain;
  let published: Record<string, number>;
  let hermesTimes: Map<string, number>;
  let hermesCalls: number;
  let hermesFails: number;
  let refP: Record<string, bigint>;
  const fee = 7n;
  const sleeps: number[] = [];
  const env = { PYTH_HERMES_API_KEY: "test-key", PYTH_PUSH_BACKOFF_MS: "100", PYTH_PUSH_MAX_RETRIES: "2" };
  const deps = () => ({
    sleep: async (ms: number) => { sleeps.push(ms); },
    nowMs: () => Number(chain.nowSeconds) * 1000,
    fetchUpdates: async () => { hermesCalls++; if (hermesFails-- > 0) throw new HermesError("Hermes answered 503", 503); return { updateData: [BLOB], publishTimes: hermesTimes }; },
  });

  beforeEach(() => {
    resetAlertMemory();
    chain = new FakeChain();
    chain.nowSeconds = 1_800_000_000n;
    sleeps.length = 0;
    hermesCalls = 0; hermesFails = 0;
    const eth = chain.deployment.markets.find((m) => m.id === MARKET_ETH)!;
    const nvda = chain.deployment.markets.find((m) => m.id === MARKET_NVDA)!;
    eth.pythId = ETH_ID; nvda.pythId = NVDA_ID;
    published = { [ETH_ID]: 1_800_000_000 - 100, [NVDA_ID]: 1_800_000_000 - 100 };
    hermesTimes = new Map([[ETH_ID, 1_800_000_000 - 2], [NVDA_ID, 1_800_000_000 - 3]]);
    refP = { [MARKET_ETH]: 0n, [MARKET_NVDA]: 5n, [MARKET_TSLA]: 5n };
    chain.readers.set("Pyth.getPriceUnsafe", (a) => ({ price: 1n, conf: 1n, expo: -8, publishTime: BigInt(published[a[0] as string] ?? 0) }));
    chain.readers.set("Pyth.getUpdateFee", () => fee);
    chain.readers.set("ODOracleGuard.config", () => ({ refMaxAge: 120 }));
    chain.readers.set("ODOracleGuard.refPrice", (a) => [refP[a[0] as string] ?? 0n, true]);
    chain.mutators.set("Pyth.updatePriceFeeds", () => { for (const k of Object.keys(published)) published[k] = Number(chain.nowSeconds) - 1; refP[MARKET_ETH] = 9n; });
  });
  const job = (overrides: Record<string, string> = {}) => createPythPushJob(chain.context(nullSql, { ...env, ...overrides }), deps());

  test("pushes with exactly the fee Pyth quoted, for the stale markets, then reports health", async () => {
    const result = await job()();
    expect(result).toMatchObject({ idle: false, pushed: ["NVDA", "ETH"], feeWei: "7" });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ contract: "Pyth", name: "updatePriceFeeds", value: fee, simulated: false });
    expect(chain.sent[0]!.data).toBe(encodeFunctionData({ abi: PythAbi, functionName: "updatePriceFeeds", args: [[BLOB]] }));
  });

  test("skips when the on-chain price is already fresh enough, and when Hermes has nothing newer", async () => {
    published[ETH_ID] = 1_800_000_000 - 30; published[NVDA_ID] = 1_800_000_000 - 30;
    expect(await job()()).toMatchObject({ idle: true, reason: "fresh" });
    expect(hermesCalls).toBe(0);
    published[ETH_ID] = 1_800_000_000 - 100; published[NVDA_ID] = 1_800_000_000 - 100;
    hermesTimes = new Map([[ETH_ID, 1_800_000_000 - 100], [NVDA_ID, 1_800_000_000 - 200]]);
    expect(await job()()).toMatchObject({ idle: true, reason: "no_newer_print" });
    expect(chain.sent).toHaveLength(0);
  });

  test("refMaxAge is read per market, not hardcoded", async () => {
    chain.readers.set("ODOracleGuard.config", () => ({ refMaxAge: 1000 }));
    expect(await job()()).toMatchObject({ idle: true, reason: "fresh" }); // 100 s old is fresh under 1000
  });

  test("no key: idle, one warning, nothing fetched or sent", async () => {
    const warnings: string[] = [];
    const context = chain.context(nullSql, { PYTH_HERMES_API_KEY: "" });
    (context as { logger: unknown }).logger = { warn: (_o: unknown, m: string) => warnings.push(m), info() {}, error() {} };
    const run = createPythPushJob(context, deps());
    expect(await run()).toMatchObject({ idle: true, reason: "no_hermes_key" });
    expect(await run()).toMatchObject({ idle: true, reason: "no_hermes_key" });
    expect(warnings).toHaveLength(1);
    expect(hermesCalls).toBe(0);
    expect(chain.sent).toHaveLength(0);
  });

  test("retries Hermes with doubling backoff, then gives up after the bound", async () => {
    hermesFails = 2;
    expect(await job()()).toMatchObject({ idle: false });
    expect(hermesCalls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    hermesFails = 99; hermesCalls = 0;
    published[ETH_ID] = 1_800_000_000 - 100;
    await expect(job()()).rejects.toThrow("503");
    expect(hermesCalls).toBe(3);
  });

  test("stops at the daily budget and alerts", async () => {
    const run = job({ PYTH_PUSH_DAILY_BUDGET_ETH: "0" });
    expect(await run()).toMatchObject({ idle: true, reason: "budget_exhausted" });
    expect(chain.sent).toHaveLength(0);
  });

  test("dry run simulates the push and spends no budget", async () => {
    chain.dryRun = true;
    expect(await job()()).toMatchObject({ idle: false, dryRun: true });
    expect(chain.sent[0]).toMatchObject({ simulated: true, value: fee });
  });

  test("health: a market with refP 0 is reported with a reason; the status mapper reads it", async () => {
    refP[MARKET_ETH] = 0n;
    chain.readers.set("Pyth.getPriceUnsafe", (a) => {
      if (a[0] === NVDA_ID) throw new RevertError({ name: "PriceFeedNotFound", args: [], signature: "0x" }, undefined);
      return { price: 1n, conf: 1n, expo: -8, publishTime: BigInt(published[a[0] as string] ?? 0) };
    });
    const refs = await checkReferences(chain.context(nullSql));
    expect(refs.find((r) => r.symbol === "ETH")).toMatchObject({ ok: false, source: "none", reason: "pyth_stale_and_no_twap", pythAgeSeconds: 100, refMaxAge: 120 });
    expect(refs.find((r) => r.symbol === "NVDA")).toMatchObject({ ok: true, source: "pyth", pythAgeSeconds: null });
    expect(refs.find((r) => r.symbol === "TSLA")).not.toHaveProperty("reason");
    chain.readers.set("ODOracleGuard.refPrice", () => [5n, false]);
    expect((await checkReferences(chain.context(nullSql))).find((r) => r.symbol === "TSLA")).toMatchObject({ ok: true, source: "twap" });
    const status = oracleOf({ checkedAt: "2026-01-01T00:00:00.000Z", markets: refs.map((r) => ({ ...r })) });
    expect(status?.ok).toBe(false);
    expect(status?.markets.find((m) => m.symbol === "ETH")?.reason).toBe("pyth_stale_and_no_twap");
    expect(oracleOf(undefined)).toBeNull();
  });
});

describe("hermes client", () => {
  test("sends the key in the header only, parses blobs and publish times", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify({ binary: { encoding: "hex", data: ["abcd"] }, parsed: [{ id: "AA".repeat(32), price: { publish_time: 5 } }] }));
    }) as unknown as typeof fetch;
    const out = await fetchLatestUpdates(["aa".repeat(32)], { baseUrl: "https://h.example/", apiKey: "SECRET", apiKeyHeader: "x-api-key", fetch: fake });
    expect(seen!.url).not.toContain("SECRET");
    expect(seen!.headers["x-api-key"]).toBe("SECRET");
    expect(out.updateData).toEqual(["0xabcd"]);
    expect(out.publishTimes.get(`0x${"aa".repeat(32)}`)).toBe(5);
    const bad = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchLatestUpdates(["aa"], { baseUrl: "https://h.example", apiKey: "", apiKeyHeader: "x", fetch: bad })).rejects.toThrow("404");
  });
});

describe("Hermes auth header", () => {
  test("Authorization gets a Bearer prefix, other headers send the raw key", () => {
    
    expect(authHeaderValue("Authorization", "k1")).toBe("Bearer k1");
    expect(authHeaderValue("authorization", "Bearer k1")).toBe("Bearer k1");
    expect(authHeaderValue("x-api-key", "k1")).toBe("k1");
  });
});
