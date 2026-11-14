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
