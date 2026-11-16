import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTimeout } from "../policy";
import { ArcusVenue, createLiveArcusPort } from "./arcus";
import { ArcusHttp, ArcusOutcomeUnknown, ArcusSigner, cancelPayload, dec18, fmt18, LiveArcusPort, orderWire, placePayload, type ArcusFetch, type ArcusMarket } from "./arcus-live";

const FIX = join(import.meta.dir, "..", "..", "..", "test", "fixtures", "arcus");
const fx = (name: string): string => readFileSync(join(FIX, name), "utf8");
const ACCOUNT = "0x00000000000000000000000000000000000a4c05"; // the placeholder used in the fixtures
// RFC 8032 section 7.1, TEST 1 (public test vector, not a key anyone holds)
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // not-a-key
const RFC_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"; // not-a-key

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
/** A fetch that serves recorded fixtures by path, plus scripted answers for the write path. */
function fixtureFetch(net: "mainnet" | "testnet", script: Partial<Record<string, (c: Call) => { status: number; body: string; headers?: Record<string, string> }>> = {}) {
  const calls: Call[] = [];
  const fetch: ArcusFetch = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) };
    calls.push(c);
    const path = new URL(url).pathname;
    const scripted = script[path] ?? Object.entries(script).find(([k]) => k.endsWith("*") && path.startsWith(k.slice(0, -1)))?.[1];
    const answer: { status: number; body: string; headers?: Record<string, string> } = scripted ? scripted(c) : serve(net, path);
    return { status: answer.status, headers: { get: (n: string) => answer.headers?.[n.toLowerCase()] ?? null }, text: async () => answer.body };
  };
  return { fetch, calls };
}
function serve(net: string, path: string): { status: number; body: string } {
  const map: Record<string, string> = {
    "/health": "mainnet-health.json", "/v1/markets": `${net}-markets.json`, "/v1/prices": `${net}-prices.json`,
    "/v1/l2OrderBook/SPY-USD": `${net}-book-SPY-USD.json`, "/v1/l2OrderBook/QQQ-USD": `${net}-book-QQQ-USD.json`,
    "/v1/account": "testnet-account.json", "/v1/positions": "testnet-positions.json", "/v1/orders": "testnet-orders.json",
  };
  const f = map[path];
  return f ? { status: 200, body: fx(f) } : { status: 404, body: '{"error":"not found"}' };
}
const http = (fetch: ArcusFetch, now = () => 1_794_831_075_740) => new ArcusHttp({ baseUrl: "https://api.testnet.arcus.xyz", fetch, sleep: async () => undefined, now, paceMs: 0 });
const spy = (): ArcusMarket => (JSON.parse(fx("mainnet-markets.json")) as { markets: ArcusMarket[] }).markets.find((m) => m.baseAsset === "SPY")!;

describe("arcus live: decimals and wire", () => {
  test("dec18_and_fmt18_are_exact", () => {
    expect(dec18("749.39")).toBe(749_390_000_000_000_000_000n);
    expect(dec18("-38740.94051")).toBe(-38_740_940_510_000_000_000_000n);
    expect(dec18("0.0000001")).toBe(100_000_000_000n);
    expect(fmt18(dec18("13.3441865"))).toBe("13.3441865");
    expect(() => dec18("1e5")).toThrow("not a decimal");
  });

  test("order_wire_snaps_inside_the_bound_and_respects_minimums", () => {
    const m = spy(); // recorded: tickSize 0.01, stepSize 0.0000001, minOrderNotional 5, minOrderSize 0.001, maxOrderSize 10000
    const mark = dec18(m.markPrice);
    const buyLimit = (mark * 10_100n) / 10_000n;
    const w = orderWire(m, 10_000n * 1_000_000n, mark, buyLimit)!;
    expect(w.s).toBe(0);
    expect(dec18(w.price)).toBeLessThanOrEqual(buyLimit);
    expect(dec18(w.price) % dec18(m.tickSize)).toBe(0n);
    expect(dec18(w.price) / dec18(m.tickSize)).toBe(w.p);
    expect(dec18(w.quantity)).toBe(w.q * dec18(m.stepSize));
    expect((dec18(w.quantity) * mark) / 10n ** 18n).toBeLessThanOrEqual(dec18("10000"));
    const sellLimit = (mark * 9_900n) / 10_000n;
    const s = orderWire(m, -10_000n * 1_000_000n, mark, sellLimit)!;
    expect(s.s).toBe(1);
    expect(dec18(s.price)).toBeGreaterThanOrEqual(sellLimit);
    expect(orderWire(m, 1_000_000n, mark, buyLimit)).toBeNull(); // 1 USD: below minOrderNotional 5 and minOrderSize
    const huge = orderWire(m, 100_000_000n * 1_000_000n, mark, buyLimit)!; // capped at maxOrderSize
    expect(huge.quantity).toBe("10000");
  });
});

describe("arcus live: signing", () => {
  test("api_key_derives_from_the_rfc8032_vector", () => {
    expect(new ArcusSigner(RFC_SEED).apiKey).toBe(RFC_PUB);
    expect(() => new ArcusSigner("abcd")).toThrow("32 bytes");
    expect(JSON.stringify({ s: new ArcusSigner(RFC_SEED) })).not.toContain(RFC_SEED);
  });

  test("place_and_cancel_payloads_match_the_documented_canonical_form", () => {
    // authentication, Scheme 1: fixed key order, no whitespace, address lowercased, c omitted when empty
    const base = { ad: "0xAbCdEf0000000000000000000000000000000001", ai: 0, ct: 1_794_831_075_740_000_000n, g: 1_798_287_075_740_000_000n, m: 23, p: 75_690n, q: 133_441_865n, r: 0 as const, s: 0 as const, t: 2 as const };
    expect(placePayload({ ...base, c: "0xabc123" })).toBe('{"ad":"0xabcdef0000000000000000000000000000000001","ai":0,"c":"0xabc123","ct":1794831075740000000,"g":1798287075740000000,"m":23,"op":1,"p":75690,"q":133441865,"r":0,"s":0,"t":2,"v":1}');
    expect(placePayload(base)).toBe('{"ad":"0xabcdef0000000000000000000000000000000001","ai":0,"ct":1794831075740000000,"g":1798287075740000000,"m":23,"op":1,"p":75690,"q":133441865,"r":0,"s":0,"t":2,"v":1}');
    expect(cancelPayload({ ad: base.ad, ai: 0, ct: 5n, id: "a1b2", m: 1 })).toBe('{"ad":"0xabcdef0000000000000000000000000000000001","ai":0,"ct":5,"id":"a1b2","m":1,"op":2,"v":1}');
    expect(() => placePayload({ ...base, c: "has space" })).toThrow("client id");
    expect(() => cancelPayload({ ad: base.ad, ai: 0, ct: 5n, m: 1 })).toThrow("exactly one");
  });

  test("signature_verifies_and_is_deterministic", () => {
    const signer = new ArcusSigner(RFC_SEED);
    const f = { ad: ACCOUNT, ai: 0, c: "x1", ct: 1n, g: 2n, m: 23, p: 1n, q: 1n, r: 0 as const, s: 1 as const, t: 2 as const };
    const { payload, signature } = signer.signPlace(f);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(RFC_PUB, "hex")]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(payload), pub, Buffer.from(signature, "hex"))).toBe(true);
    expect(signer.signPlace(f).signature).toBe(signature); // Ed25519 is deterministic
  });
});

describe("arcus live: reads from recorded responses", () => {
  test("markets_marks_depth_equity_positions", async () => {
    const { fetch, calls } = fixtureFetch("testnet");
    const port = new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0 });
    const markets = await port.markets();
    expect(markets.get("SPY")).toEqual({ open: true, proxy: false });
    expect(markets.get("QQQ")).toEqual({ open: true, proxy: false });
    expect(markets.get("BAC")).toEqual({ open: false, proxy: false }); // recorded OFFLINE
    expect((await port.mark("SPY")).px).toBe(dec18("751.05"));
    expect(await port.equityUsd()).toBe(289_443_616_886n); // equity "289443.616886233" to raw USDG
    expect(await port.positionUnits("XRP")).toBe(dec18("-38740.94051"));
    expect(await port.positionUnits("SPY")).toBe(0n);
    expect(calls.every((c) => c.method === "GET" && !("X-API-Key" in c.headers))).toBe(true); // reads send no auth header
    expect(calls.find((c) => c.url.includes("/v1/account"))!.url).toContain(`address=${ACCOUNT}`);
  });

  test("depth_sums_the_recorded_mainnet_book", async () => {
    const { fetch, calls } = fixtureFetch("mainnet");
    const port = new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0 });
    expect(await port.depthUsd("SPY", "buy")).toBe(916_628_709_800n); // asks: 916628.709800388
    expect(await port.depthUsd("SPY", "sell")).toBe(496_555_763_763n); // bids: 496555.763763505
    expect(calls.at(-1)!.url).toContain("/v1/l2OrderBook/SPY-USD?nLevels=20");
  });

  test("an_empty_account_reads_zero", async () => {
    const { fetch } = fixtureFetch("testnet", { "/v1/account": () => ({ status: 404, body: fx("testnet-account-404.json") }) });
    expect(await new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0 }).equityUsd()).toBe(0n);
  });

  test("venue_over_live_port", async () => {
    const { fetch } = fixtureFetch("testnet");
    const venue = new ArcusVenue(new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0 }), () => 1_794_831_075_740, { fundable: false, postsEquity: true });
    expect((await venue.healthy()).ok).toBe(true);
    expect(venue.canTrade("SPY")).toBe(true);
    expect(venue.canTrade("BAC")).toBe(false);
    expect(venue.canTrade("NOPE")).toBe(false);
    expect(venue.fundable).toBe(false);
    expect(venue.postsEquity).toBe(true);
    const expected = (dec18("-38740.94051") * dec18("0.9542")) / 10n ** 18n / 10n ** 12n;
    expect(await venue.netPositionUsd("XRP")).toBe(expected);
  });

  test("get_retries_429_and_5xx_then_gives_up", async () => {
    let n = 0;
    const slept: number[] = [];
    const flaky: ArcusFetch = async () => {
      n++;
      if (n === 1) return { status: 429, headers: { get: (h: string) => (h === "retry-after" ? "2" : null) }, text: async () => '{"error":"rate limited"}' };
      if (n === 2) return { status: 502, text: async () => "" };
      return { status: 200, text: async () => '{"status":"ok"}' };
    };
    const h = new ArcusHttp({ baseUrl: "https://x", fetch: flaky, sleep: async (ms) => { slept.push(ms); }, paceMs: 0 });
    expect(await h.get<{ status: string }>("/health")).toEqual({ status: "ok" });
    expect(slept).toEqual([2_000, 2_000]);
    const dead = new ArcusHttp({ baseUrl: "https://x", fetch: async () => ({ status: 503, text: async () => "" }), sleep: async () => undefined, paceMs: 0 });
    await expect(dead.get("/health")).rejects.toThrow("after 8 tries");
    const bad = new ArcusHttp({ baseUrl: "https://x", fetch: async () => ({ status: 400, text: async () => '{"error":"bad"}' }), sleep: async () => undefined, paceMs: 0 });
    await expect(bad.get("/health")).rejects.toThrow("HTTP 400");
  });
});

describe("arcus live: orders (scripted; nothing is sent to a real API)", () => {
  const CID = "0x0123456789abcdef0123456789abcdef";
  test("ioc_place_signs_waits_for_terminal_and_returns_the_fill", async () => {
    let polls = 0;
    const { fetch, calls } = fixtureFetch("testnet", {
      "/v1/placeOrder": () => ({ status: 202, body: JSON.stringify({ orderId: "a1b2c3", clientId: CID, status: "ACK" }) }),
      "/v1/order/*": () => (++polls < 2
        ? { status: 200, body: JSON.stringify({ orderId: "a1b2c3", clientId: CID, marketId: 23, side: "SELL", status: "OPEN" }) }
        : { status: 200, body: JSON.stringify({ orderId: "a1b2c3", clientId: CID, marketId: 23, side: "SELL", status: "CANCELED", filledSize: "10", avgFillPrice: "750.5" }) }),
    });
    const signer = new ArcusSigner(RFC_SEED);
    const port = new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0, signer });
    const mark = dec18("751.05");
    const fill = await port.placeOrder("SPY", -20_000n * 1_000_000n, (mark * 9_900n) / 10_000n, CID);
    expect(fill).toEqual({ ref: "a1b2c3", filledUsd: -7_505_000_000n, avgPx: dec18("750.5"), feesUsd: 0n }); // IOC partial: 10 x 750.5
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`https://api.testnet.arcus.xyz/v1/placeOrder?address=${ACCOUNT}`);
    expect(post.headers["X-API-Key"]).toBe(RFC_PUB);
    const ts = post.headers["X-Timestamp"]!;
    expect(ts).toMatch(/^\d{19}$/); // Unix nanoseconds
    expect(post.body).toContain(`"timestamp":${ts}}`);
    expect(post.body).toContain('"timeInForce":"IOC"');
    expect(post.body).toContain(`"clientId":"${CID}"`);
    const body = JSON.parse(post.body!.replace(/"timestamp":(\d+)/, '"timestamp":"$1"')) as Record<string, string | number>;
    const m = spy();
    const payload = placePayload({ ad: ACCOUNT, ai: 0, c: CID, ct: BigInt(ts), g: BigInt(body.goodTilTime!) * 1000n, m: 23, p: dec18(String(body.price)) / dec18(m.tickSize), q: dec18(String(body.quantity)) / dec18(m.stepSize), r: 0, s: 1, t: 2 });
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(RFC_PUB, "hex")]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(payload), pub, Buffer.from(post.headers["X-Signature"]!, "hex"))).toBe(true);
    expect(BigInt(body.goodTilTime!)).toBeGreaterThan(BigInt(1_794_831_075_740 + 30 * 86_400_000) * 1000n); // >= a month ahead
  });

  test("ambiguous_write_is_never_retried_and_is_not_a_timeout", async () => {
    let posts = 0;
    const { fetch } = fixtureFetch("testnet", { "/v1/placeOrder": () => { posts++; return { status: 502, body: "" }; } });
    const port = new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0, signer: new ArcusSigner(RFC_SEED) });
    const err = await port.placeOrder("SPY", 10_000n * 1_000_000n, dec18("760"), CID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArcusOutcomeUnknown);
    expect(isTimeout(err)).toBe(false); // the service must not resend; it reconciles by client id
    expect(posts).toBe(1);
  });

  test("rate_limited_write_is_retried", async () => {
    let posts = 0;
    const { fetch } = fixtureFetch("testnet", {
      "/v1/placeOrder": () => (++posts === 1 ? { status: 429, body: '{"error":"rate limited","reason":"account_empty","retryAfterMs":850}' } : { status: 200, body: JSON.stringify({ orderId: "ff", status: "FILLED" }) }),
      "/v1/order/*": () => ({ status: 200, body: JSON.stringify({ orderId: "ff", marketId: 23, side: "BUY", status: "FILLED", filledSize: "1", avgFillPrice: "751" }) }),
    });
    const port = new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0, signer: new ArcusSigner(RFC_SEED) });
    expect((await port.placeOrder("SPY", 751n * 1_000_000n, dec18("760"), CID)).filledUsd).toBe(751_000_000n);
    expect(posts).toBe(2);
  });

  test("order_by_client_id_reads_history", async () => {
    const { fetch } = fixtureFetch("testnet");
    const port = new LiveArcusPort({ http: http(fetch), account: ACCOUNT, accountIndex: 0 });
    expect(await port.orderByClientId(CID)).toBeNull(); // recorded history has no client ids
    const { fetch: f2 } = fixtureFetch("testnet", { "/v1/orders": () => ({ status: 200, body: JSON.stringify({ orders: [{ orderId: "o9", clientId: CID, marketId: 23, side: "BUY", status: "FILLED", filledSize: "2", avgFillPrice: "750" }] }) }) });
    expect(await new LiveArcusPort({ http: http(f2), account: ACCOUNT, accountIndex: 0 }).orderByClientId(CID)).toEqual({ ref: "o9", filledUsd: 1_500_000_000n, avgPx: dec18("750"), feesUsd: 0n });
  });

  test("dry_run_port_has_no_signer_and_never_deposits", async () => {
    const { fetch, calls } = fixtureFetch("testnet");
    const port = createLiveArcusPort({ network: "testnet", account: ACCOUNT, accountIndex: 0, dryRun: true, fetch });
    await expect(port.placeOrder("SPY", 10_000_000n, dec18("760"), CID)).rejects.toThrow("no signer");
    await expect(port.deposit(1n)).rejects.toThrow("owner's runbook");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("arcus live: building", () => {
  test("live_port_refuses_without_credentials", () => {
    expect(() => createLiveArcusPort({ network: "mainnet", account: "", accountIndex: 0, dryRun: true })).toThrow("ARCUS_ACCOUNT_ADDRESS is not set");
    expect(() => createLiveArcusPort({ network: "mainnet", account: ACCOUNT, accountIndex: 0, dryRun: false })).toThrow("needs ARCUS_API_SIGNING_KEY_FILE");
    expect(() => createLiveArcusPort({ network: "mainnet", account: ACCOUNT, accountIndex: 12, dryRun: true })).toThrow("accountIndex");
  });

  test("signing_key_file_must_be_private", () => {
    const dir = mkdtempSync(join(tmpdir(), "arcus-key-"));
    const file = join(dir, "arcus.key");
    writeFileSync(file, `${RFC_SEED}\n`);
    chmodSync(file, 0o644);
    expect(() => createLiveArcusPort({ network: "testnet", account: ACCOUNT, accountIndex: 0, signingKeyFile: file, dryRun: false })).toThrow("chmod 600");
    chmodSync(file, 0o600);
    expect(createLiveArcusPort({ network: "testnet", account: ACCOUNT, accountIndex: 0, signingKeyFile: file, dryRun: false })).toBeInstanceOf(LiveArcusPort);
  });
});
