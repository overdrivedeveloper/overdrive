import { afterAll, expect, test } from "bun:test";
import { harness, WAD } from "../test-support";

const h = await harness("quote", { chain: {}, config: { API_QUOTE_CACHE_MS: "2000" } });
afterAll(async () => { await h?.close(); });

test("rpc_calls_bounded_and_coalesced", async () => {
  if (!h) return;
  const slow = await harness("quote_slow", { config: { API_QUOTE_CACHE_MS: "2000" } });
  if (!slow) return;
  // slow chain so that identical requests overlap in flight
  const hook = slow.hook;
  const chain = hook.asChain({}, { delayMs: 40 });
  const deps = { ...slow.deps, chain };
  const { createApiApp } = await import("../app");
  const app = createApiApp(deps);
  const url = "/v1/quote?gear=TSLA-SPORT&side=buy&usdg=5000000";
  const responses = await Promise.all(Array.from({ length: 10 }, () => app.request(url)));
  expect(responses.every((r) => r.status === 200)).toBe(true);
  // one request = at most 2 chain calls (V4Quoter + IODMinter.quote); ten identical in-flight requests = one request's worth
  expect(chain.calls.quote).toBe(1);
  expect(chain.calls.minter).toBe(1);
  // within API_QUOTE_CACHE_MS the same trade is served from cache; another size is a fresh pair of calls
  await app.request(url);
  expect(chain.calls.quote).toBe(1);
  await app.request("/v1/quote?gear=TSLA-SPORT&side=buy&usdg=6000000");
  expect(chain.calls.quote).toBe(2);
  expect(chain.calls.minter).toBe(2);
  expect(chain.calls.other).toBe(0);
  // a budget of 1 RPC per request cannot be met by a two-source quote: it fails closed instead of exceeding it
  const tight = createApiApp({ ...deps, cache: new (await import("../cache")).TtlCache(), config: { ...deps.config, API_QUOTE_MAX_RPC_PER_REQUEST: 1 } });
  const refused = await tight.request("/v1/quote?gear=TSLA-SPORT&side=buy&usdg=7000000");
  expect(refused.status).toBe(502);
  await slow.close();
});

test("validation: one amount that matches the side, known gear, address checked", async () => {
  if (!h) return;
  const get = async (q: string) => { const r = await h.app.request(`/v1/quote?${q}`); return { status: r.status, body: (await r.json()) as any }; };
  expect((await get("gear=NOPE&side=buy&usdg=1000000")).status).toBe(404);
  expect((await get("gear=TSLA-SPORT&side=buy")).status).toBe(400);
  expect((await get("gear=TSLA-SPORT&side=buy&tokens=5")).status).toBe(400);
  expect((await get("gear=TSLA-SPORT&side=buy&usdg=0")).status).toBe(400);
  expect((await get("gear=TSLA-SPORT&side=buy&usdg=1000000&account=0x12")).status).toBe(400);
  const ok = await get(`gear=tsla-sport&side=sell&tokens=${WAD}`);
  expect(ok.status).toBe(200);
  expect(ok.body.sellMode).toBe("instant");
  expect(ok.body.usdgOut).toBe(ok.body.amountOut);
});

test("intents are unsigned calldata from a fresh quote and refuse what cannot execute", async () => {
  if (!h) return;
  const post = async (path: string, body: unknown) => { const r = await h.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
  const account = "0x00000000000000000000000000000000000a11ce";
  const ok = await post("/v1/intent/buy", { gear: "TSLA-SPORT", account, usdg: "5000000" });
  expect(ok.status).toBe(200);
  expect(ok.body.tx.value).toBe("0");
  expect(ok.body.tx.data.startsWith("0x")).toBe(true);
  expect(ok.body.approvals[0].amount).toBe("5000000");
  expect(BigInt(ok.body.minOut)).toBeLessThanOrEqual(BigInt(ok.body.expectedOut));
  const g = h.hook.gears.get(h.deployment.gears[1]!.id.toLowerCase())!;
  g.session = 2;
  h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
  const closed = await post("/v1/intent/buy", { gear: "TSLA-SPORT", account, usdg: "5000000" });
  expect(closed.status).toBe(409);
  expect(closed.body.error).toBe("CLOSED");
  g.session = 0;
  h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
  expect((await post("/v1/intent/buy", { gear: "TSLA-SPORT", account, usdg: "5000000", minOut: "999999999999999999999999" })).status).toBe(400);
  const big = await h.app.request("/v1/intent/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gear: "TSLA-SPORT", account, usdg: "1", pad: "x".repeat(17_000) }) });
  expect(big.status).toBe(400);
});

test("intent deadline counts from the chain clock when the chain is ahead of the wall clock", async () => {
  if (!h) return;
  const { decodeFunctionData } = await import("viem");
  const { IODMinterAbi } = await import("../../abi");
  const account = "0x00000000000000000000000000000000000a11ce";
  const chain = h.deps.chain as { blockTimestamp?: () => Promise<bigint> };
  const prior = chain.blockTimestamp;
  const wall = BigInt(Math.floor((h.deps.now ? h.deps.now() : new Date()).getTime() / 1000)); // the harness may pin the clock
  const deadlineOf = async () => {
    h.deps.cache.sweep(Number.MAX_SAFE_INTEGER);
    const r = await h.app.request("/v1/intent/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gear: "TSLA-SPORT", account, usdg: "5000000", deadlineSec: 300 }) });
    const body = (await r.json()) as { tx: { data: `0x${string}` } };
    return decodeFunctionData({ abi: IODMinterAbi, data: body.tx.data }).args![4] as bigint;
  };
  try {
    chain.blockTimestamp = async () => wall + 3n * 86_400n; // a fork warped three days ahead
    expect(await deadlineOf()).toBe(wall + 3n * 86_400n + 300n);
    chain.blockTimestamp = async () => wall - 600n; // a lagging block time: the wall clock wins
    const d = await deadlineOf();
    expect(d >= wall + 300n && d <= wall + 310n).toBe(true);
  } finally { if (prior) chain.blockTimestamp = prior; else delete chain.blockTimestamp; }
});

// I8-2: a closed market with no reference quotes amountOut 0. The API must never turn that into a minimum of 0.
test("a queued sell in a closed market carries a real minimum on the quote and on the intent", async () => {
  if (!h) return;
  const post = async (path: string, body: unknown) => { const r = await h.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
  const account = "0x00000000000000000000000000000000000000a1";
  const g = [...h.hook.gears.values()].find((x) => x.id.toLowerCase() === h.deployment.gears.find((d) => d.symbol === "TSLA-SPORT")!.id.toLowerCase())!;
  const saved = { session: g.session, ref: g.refValueWad };
  g.session = 2; g.refValueWad = 0n; h.hook.block += 1n;
  try {
    const tokens = 3n * 10n ** 18n;
    const expected = (tokens * g.lastValueWad * 9_500n) / 10_000n / 10n ** 30n; // last good value less 5%
    expect(expected).toBeGreaterThan(0n);
    const q = (await (await h.app.request(`/v1/quote?gear=TSLA-SPORT&side=sell&tokens=${tokens}`)).json()) as any;
    expect(q.sellMode).toBe("queued");
    expect(q.minterQuote.amountOut).toBe("0");
    expect(q.minOutSuggested).toBe(expected.toString());
    expect(q.queue.minUsdgOutSuggested).toBe(expected.toString());
    const intent = await post("/v1/intent/sell", { gear: "TSLA-SPORT", account, tokens: tokens.toString() });
    expect(intent.status).toBe(200);
    expect(intent.body.kind).toBe("queue_sell");
    expect(intent.body.minOut).toBe(expected.toString());
    // the quote's minimum is the limit in the calldata, to the unit
    const { decodeFunctionData } = await import("viem");
    const { IODMinterAbi } = await import("../../abi");
    const call = decodeFunctionData({ abi: IODMinterAbi, data: intent.body.tx.data });
    expect(call.functionName).toBe("queueSell");
    expect((call.args as readonly unknown[])[2]).toBe(expected);
    // an explicit minimum is the caller's own choice
    expect((await post("/v1/intent/sell", { gear: "TSLA-SPORT", account, tokens: tokens.toString(), minOut: "1" })).body.minOut).toBe("1");
    // no last value: no suggestion and no intent without a minimum
    const last = g.lastValueWad; g.lastValueWad = 0n; h.hook.block += 1n;
    const none = (await (await h.app.request(`/v1/quote?gear=TSLA-SPORT&side=sell&tokens=${tokens + 1n}`)).json()) as any;
    expect(none.minOutSuggested).toBe(null);
    expect(none.queue.minUsdgOutSuggested).toBe(null);
    const refused = await post("/v1/intent/sell", { gear: "TSLA-SPORT", account, tokens: (tokens + 1n).toString() });
    expect(refused.status).toBe(409);
    g.lastValueWad = last;
  } finally { g.session = saved.session; g.refValueWad = saved.ref; h.hook.block += 1n; }
});

// I9-3: a sell above what the PoolManager holds is built on the direct IODMinter.sell path with the quoted minimum.
test("a sell above the hook seed builds IODMinter.sell with the quoted minimum", async () => {
  const { encodeErrorResult, decodeFunctionData, parseAbi } = await import("viem");
  const { IODMinterAbi } = await import("../../abi");
  const short = parseAbi(["error PoolManagerShort(address token, uint256 have, uint256 need)"]);
  const seed = WAD;
  const inner = (need: bigint) => encodeErrorResult({ abi: short, errorName: "PoolManagerShort", args: [`0x${"22".repeat(20)}`, seed, need] });
  const hs = await harness("quote_seed", { chain: {} });
  if (!hs) return;
  try {
    const real = hs.chain.quoter.quote.bind(hs.chain.quoter);
    hs.chain.quoter.quote = async (i: any) => {
      if (i.side === "sell" && i.exactIn > seed) throw { errorName: "WrappedError", args: [`0x${"33".repeat(20)}`, "0x575e24b4", inner(i.exactIn), "0x"] };
      return real(i);
    };
    const post = async (path: string, body: unknown) => { const r = await hs.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
    const tokens = 100n * seed;
    const q = (await (await hs.app.request(`/v1/quote?gear=TSLA-SPORT&side=sell&tokens=${tokens}`)).json()) as any;
    expect(q.buyable).toBe(true);
    expect(q.source).toBe("minter");
    expect(q.sellMode).toBe("instant");
    expect(BigInt(q.amountOut)).toBeGreaterThan(0n);
    const intent = await post("/v1/intent/sell", { gear: "TSLA-SPORT", account: "0x00000000000000000000000000000000000a11ce", tokens: tokens.toString() });
    expect(intent.status).toBe(200);
    expect(intent.body.kind).toBe("sell");
    expect(intent.body.tx.to.toLowerCase()).toBe(hs.deployment.contracts.ODMinter!.toLowerCase());
    const call = decodeFunctionData({ abi: IODMinterAbi, data: intent.body.tx.data });
    expect(call.functionName).toBe("sell");
    expect((call.args as readonly unknown[])[2]).toBe(BigInt(q.minOutSuggested)); // quote equals execution
    expect(intent.body.minOut).toBe(q.minOutSuggested);
    // a buy is unaffected
    expect((await post("/v1/intent/buy", { gear: "TSLA-SPORT", account: "0x00000000000000000000000000000000000a11ce", usdg: "5000000" })).status).toBe(200);
  } finally { await hs.close(); }
});
