import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { actionHash, bookFromL2, HlHttp, HlSigner, hlRoute, HyperliquidVenue, msgpack, priceToWire, resolveAssets, sizeToWire, type FetchLike, type HlAction } from "./hyperliquid";

type Handler = (path: string, body: Record<string, unknown>) => { status?: number; json?: unknown };
function fakeFetch(handler: Handler) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const fn: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push({ path, body });
    const r = handler(path, body);
    return { status: r.status ?? 200, json: async () => r.json, text: async () => JSON.stringify(r.json ?? "") };
  };
  return { fn, seen };
}

const universe = {
  "": [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }],
  xyz: [{ name: "xyz:OLD", szDecimals: 3, isDelisted: true }, { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 10 }, { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 10 }, { name: "xyz:SP500", szDecimals: 2, maxLeverage: 20 }],
  bart: [{ name: "bart:QQQ", szDecimals: 2 }, { name: "bart:SPY", szDecimals: 2, isDelisted: true }],
} as Record<string, unknown[]>;
const infoHandler = (books: Record<string, unknown> = {}): Handler => (_path, body) => {
  if (body.type === "perpDexs") return { json: [null, { name: "abc" }, { name: "xyz" }, { name: "bart" }] };
  if (body.type === "meta") return { json: { universe: universe[(body.dex as string) ?? ""] ?? [] } };
  if (body.type === "l2Book") return { json: books[body.coin as string] ?? { levels: [[], []] } };
  return { json: {} };
};
const noSleep = { sleep: async () => undefined };

describe("hyperliquid venue", () => {
  test("resolves_assets_live_and_skips_delisted", async () => {
    const { fn, seen } = fakeFetch(infoHandler());
    const http = new HlHttp({ baseUrl: "http://hl", fetch: fn, ...noSleep, paceMs: 0 });
    const assets = await resolveAssets(http, ["BTC", "xyz:TSLA", "xyz:OLD", "xyz:SP500", "bart:SPY", "bart:QQQ", "nope:X"]);
    // HIP-3 id = 100000 + dexIndex x 10000 + index; xyz is dex 2 on this server, so a hard-coded 1 would be wrong
    expect(assets.get("xyz:TSLA")?.asset).toBe(100_000 + 2 * 10_000 + 1);
    expect(assets.get("xyz:SP500")?.asset).toBe(100_000 + 2 * 10_000 + 3);
    expect(assets.get("bart:QQQ")?.asset).toBe(100_000 + 3 * 10_000 + 0);
    expect(assets.get("BTC")?.asset).toBe(0);
    expect(assets.has("xyz:OLD")).toBe(false);   // delisted
    expect(assets.has("bart:SPY")).toBe(false);  // delisted
    expect(assets.has("nope:X")).toBe(false);    // unknown dex
    expect(seen.map((s) => s.body)).toContainEqual({ type: "meta", dex: "xyz" });

    // route table: mainnet SPY is the SP500 proxy, testnet SPY is bart; a name outside the table is refused
    expect(hlRoute("mainnet", "SPY")).toEqual({ coin: "xyz:SP500", proxy: true });
    expect(hlRoute("testnet", "SPY")).toEqual({ coin: "bart:SPY", proxy: false });
    expect(hlRoute("mainnet", "xyz:TSLA")).toBeNull();
    const venue = new HyperliquidVenue({ http, network: "mainnet", account: `0x${"11".repeat(20)}`, symbols: ["TSLA", "SPY", "AMD"] });
    await venue.refresh(true);
    expect(venue.canTrade("TSLA")).toBe(true);
    expect(venue.canTrade("SPY")).toBe(true);
    expect(venue.basis("SPY").proxy).toBe(true);
    expect(venue.canTrade("AMD")).toBe(false);   // not listed on this server
    expect(venue.canTrade("NVDA")).toBe(false);  // listed, but not a hedger symbol: never resolved
  });

  test("pacing_and_backoff", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const statuses = [429, 503, 500, 200, 200];
    const { fn } = fakeFetch(() => ({ status: statuses.shift()!, json: { ok: true } }));
    const http = new HlHttp({ baseUrl: "http://hl", fetch: fn, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
    expect(await http.post("/info", { type: "meta" })).toEqual({ ok: true });
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);          // the retry waits already exceed the 250 ms pace
    await http.post("/info", { type: "meta" });
    expect(sleeps.at(-1)).toBe(250);                        // back-to-back calls are spaced 250 ms
    // doubling caps at 30 s and gives up after 8 tries
    const always = fakeFetch(() => ({ status: 502 }));
    const sleeps2: number[] = [];
    const h2 = new HlHttp({ baseUrl: "http://hl", fetch: always.fn, paceMs: 0, sleep: async (ms) => { sleeps2.push(ms); } });
    await expect(h2.post("/info", {})).rejects.toThrow("after 8 tries");
    expect(sleeps2).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(always.seen).toHaveLength(8);
    // a 4xx other than 429 is an error at once
    const bad = fakeFetch(() => ({ status: 400, json: "bad" }));
    await expect(new HlHttp({ baseUrl: "http://hl", fetch: bad.fn, ...noSleep }).post("/info", {})).rejects.toThrow("HTTP 400");
    expect(bad.seen).toHaveLength(1);
  });

  test("empty_side_is_no_price", async () => {
    expect(bookFromL2([[{ px: "99", sz: "2", n: 1 }], []]).mid).toBeNull();
    expect(bookFromL2([[], [{ px: "101", sz: "1", n: 1 }]]).mid).toBeNull();
    expect(bookFromL2(undefined).mid).toBeNull();
    const b = bookFromL2([[{ px: "99", sz: "2", n: 1 }, { px: "98", sz: "1", n: 1 }], [{ px: "101", sz: "3", n: 1 }]]);
    expect(b.mid).toBe(100);
    expect(b.bidDepthUsd).toBe(99 * 2 + 98);
    expect(b.askDepthUsd).toBe(303);
    const { fn } = fakeFetch(infoHandler({ "xyz:TSLA": { levels: [[{ px: "400", sz: "1", n: 1 }], []] } }));
    const venue = new HyperliquidVenue({ http: new HlHttp({ baseUrl: "http://hl", fetch: fn, ...noSleep, paceMs: 0 }), network: "mainnet", account: `0x${"11".repeat(20)}`, symbols: ["TSLA"] });
    await venue.refresh(true);
    await expect(venue.markPrice("TSLA")).rejects.toThrow("no price");
    expect(await venue.maxTradeUsd("TSLA", "buy")).toBe(0n);
  });

  test("signer_cannot_move_funds", async () => {
    // the venue code holds no collateral-moving action at all
    const src = readFileSync(join(import.meta.dir, "hyperliquid.ts"), "utf8");
    for (const word of ["withdraw", "usdSend", "spotSend", "sendAsset", "agentSendAsset", "approveAgent", "usdClassTransfer", "vaultTransfer"]) {
      expect(src.toLowerCase().includes(word.toLowerCase()), word).toBe(false);
    }
    const signer = new HlSigner(generatePrivateKey(), "testnet");
    await expect(signer.sign({ type: "withdraw3", destination: "0x0", amount: "1" } as unknown as HlAction, 1)).rejects.toThrow("refuses");
    // the three allowed actions sign with the phantom agent and recover to the agent
    const action: HlAction = { type: "order", orders: [{ a: 110001, b: true, p: "400.5", s: "0.25", r: false, t: { limit: { tif: "Ioc" } }, c: "0x0123456789abcdef0123456789abcdef" }], grouping: "na" };
    const signed = await signer.sign(action, 1_700_000_000_000);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent", message: { source: "b", connectionId: actionHash(action, 1_700_000_000_000) },
      signature: `${signed.signature.r}${signed.signature.s.slice(2)}${signed.signature.v.toString(16)}` as Hex,
    });
    expect(recovered).toBe(signer.address);
    expect(signed.vaultAddress).toBeNull();
    // msgpack shapes used by the hash (format spec): fixmap, fixstr, uint16/uint32, bools, nested
    expect(Buffer.from(msgpack({ a: 1, b: true })).toString("hex")).toBe("82a16101a162c3");
    expect(Buffer.from(msgpack(110001)).toString("hex")).toBe("ce0001adb1");
    expect(Buffer.from(msgpack([300, false, null])).toString("hex")).toBe("93cd012cc2c0");
    // wire rounding: 5 significant figures, at most 6 - szDecimals decimals; sizes floor to szDecimals
    expect(priceToWire(400.56789, 3)).toBe("400.57");
    expect(priceToWire(0.0123456, 0)).toBe("0.012346");
    expect(sizeToWire(0.123456, 3)).toBe("0.123");
  });
});
