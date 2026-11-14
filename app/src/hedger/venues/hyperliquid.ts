// Hyperliquid venue (R16). Assets are resolved live (perpDexs, meta with dex; never hard-coded indexes), delisted entries
// are skipped, info calls are paced at 250 ms and back off on 429 and 5xx (1 s doubling, cap 30 s, 8 tries), prices come
// from the l2Book mid (20 levels per side, so depth is a floor; an empty side means no price), and any market whose name
// does not match the route table is refused.
// R13: the signer builds exactly three action kinds (order, cancel, updateLeverage). It has no code path for collateral
// movement of any kind; collateral is the owner's runbook (todo 23).
import { concat, keccak256, numberToHex, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG_TO_WAD, WAD } from "../../lib/fixed";
import type { IHedgeVenue, VenueFill } from "../types";

export type HlNetwork = "mainnet" | "testnet";

// ------------------------------------------------------------------------------------------------------------ route table
/** The only Hyperliquid markets the hedger may trade, per network. Proxy = an index stands in for the ETF. */
export function hlRoute(network: HlNetwork, symbol: string): { coin: string; proxy: boolean } | null {
  if (symbol === "ETH" || symbol === "BTC") return { coin: symbol, proxy: false };
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) return null;
  if (network === "mainnet") {
    // facts 2026-11-11: xyz lists SP500 and XYZ100 but no SPY or QQQ symbol
    if (symbol === "SPY") return { coin: "xyz:SP500", proxy: true };
    if (symbol === "QQQ") return { coin: "xyz:XYZ100", proxy: true };
    return { coin: `xyz:${symbol}`, proxy: false };
  }
  // testnet: dex `bart` lists SPY and QQQ; stocks on `xyz`
  if (symbol === "SPY" || symbol === "QQQ") return { coin: `bart:${symbol}`, proxy: false };
  return { coin: `xyz:${symbol}`, proxy: false };
}

// ------------------------------------------------------------------------------------------------------------ info client
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface HlHttpOptions {
  baseUrl: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  paceMs?: number;
}

export class HlHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "HlHttpError"; }
}

/** Paced, retrying JSON POST to /info and /exchange. */
export class HlHttp {
  private last = Number.NEGATIVE_INFINITY;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly paceMs: number;
  constructor(private readonly options: HlHttpOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
    this.paceMs = options.paceMs ?? 250;
  }

  async post(path: "/info" | "/exchange", body: unknown): Promise<unknown> {
    let delay = 1_000;
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + this.paceMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      let status = 0;
      try {
        const res = await this.fetchFn(`${this.options.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        status = res.status;
        if (status >= 200 && status < 300) return await res.json();
        if (status !== 429 && status < 500) throw new HlHttpError(`hyperliquid ${path} HTTP ${status}: ${(await res.text()).slice(0, 200)}`, status);
      } catch (error) {
        if (error instanceof HlHttpError) throw error;
        status = 0; // network error: retried like a 5xx
      }
      if (attempt >= 8) throw new HlHttpError(`hyperliquid ${path} failed after ${attempt} tries (last HTTP ${status})`, status);
      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ assets
export interface HlAsset { coin: string; asset: number; szDecimals: number; maxLeverage: number }

/** Resolves every route-table coin live: dex index from perpDexs, index from meta; delisted entries are skipped. */
export async function resolveAssets(http: HlHttp, coins: readonly string[]): Promise<Map<string, HlAsset>> {
  const out = new Map<string, HlAsset>();
  const dexes = (await http.post("/info", { type: "perpDexs" })) as ({ name: string } | null)[];
  const byDex = new Map<string, string[]>();
  for (const coin of coins) {
    const dex = coin.includes(":") ? coin.split(":")[0]! : "";
    byDex.set(dex, [...(byDex.get(dex) ?? []), coin]);
  }
  for (const [dex, wanted] of byDex) {
    const dexIndex = dex === "" ? 0 : dexes.findIndex((d) => d?.name === dex);
    if (dexIndex < 0) continue;
    const meta = (await http.post("/info", dex === "" ? { type: "meta" } : { type: "meta", dex })) as { universe: { name: string; szDecimals: number; maxLeverage?: number; isDelisted?: boolean }[] };
    meta.universe.forEach((entry, index) => {
      if (entry.isDelisted || !wanted.includes(entry.name)) return;
      const asset = dex === "" ? index : 100_000 + dexIndex * 10_000 + index;
      out.set(entry.name, { coin: entry.name, asset, szDecimals: entry.szDecimals, maxLeverage: entry.maxLeverage ?? 1 });
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ book
export interface HlLevel { px: string; sz: string; n: number }
export interface HlBook { mid: number | null; bidDepthUsd: number; askDepthUsd: number }

/** Mid from the best bid and ask; an empty side is no price (never zero). Depth sums px x sz of the 20 levels shown. */
export function bookFromL2(levels: readonly [readonly HlLevel[], readonly HlLevel[]] | undefined): HlBook {
  const [bids, asks] = levels ?? [[], []];
  const depth = (side: readonly HlLevel[]) => side.reduce((a, l) => a + Number(l.px) * Number(l.sz), 0);
  const bestBid = bids[0] ? Number(bids[0].px) : NaN;
  const bestAsk = asks[0] ? Number(asks[0].px) : NaN;
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : null;
  return { mid, bidDepthUsd: depth(bids), askDepthUsd: depth(asks) };
}

// ------------------------------------------------------------------------------------------------------------ wire format
/** Hyperliquid price rule: at most 5 significant figures and at most (6 - szDecimals) decimals. */
export function priceToWire(px: number, szDecimals: number): string {
  const sig = Number(px.toPrecision(5));
  const decimals = Math.max(0, 6 - szDecimals);
  return trimNum(sig.toFixed(decimals));
}
export const sizeToWire = (sz: number, szDecimals: number): string => trimNum((Math.floor(sz * 10 ** szDecimals) / 10 ** szDecimals).toFixed(szDecimals));
const trimNum = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** Minimal msgpack encoder for the action shapes below (maps keep insertion order, as the reference SDK does). */
export function msgpack(value: unknown): Uint8Array {
  const out: number[] = [];
  const u = (n: number, bytes: number) => { for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff); };
  const enc = (v: unknown): void => {
    if (v === null || v === undefined) out.push(0xc0);
    else if (v === true) out.push(0xc3);
    else if (v === false) out.push(0xc2);
    else if (typeof v === "number") {
      if (!Number.isInteger(v) || v < 0) throw new Error("msgpack: only non-negative integers are used in actions");
      if (v < 0x80) out.push(v);
      else if (v < 0x100) { out.push(0xcc); u(v, 1); }
      else if (v < 0x10000) { out.push(0xcd); u(v, 2); }
      else if (v < 0x100000000) { out.push(0xce); u(v, 4); }
      else { out.push(0xcf); u(v, 8); }
    } else if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      if (b.length < 32) out.push(0xa0 | b.length);
      else if (b.length < 0x100) { out.push(0xd9); u(b.length, 1); }
      else { out.push(0xda); u(b.length, 2); }
      out.push(...b);
    } else if (Array.isArray(v)) {
      if (v.length < 16) out.push(0x90 | v.length); else { out.push(0xdc); u(v.length, 2); }
      v.forEach(enc);
    } else if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length < 16) out.push(0x80 | entries.length); else { out.push(0xde); u(entries.length, 2); }
      for (const [k, x] of entries) { enc(k); enc(x); }
    } else throw new Error(`msgpack: unsupported ${typeof v}`);
  };
  enc(value);
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------------------------------------------------ signer
export interface HlOrderWire { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } }; c?: Hex }
export type HlAction =
  | { type: "order"; orders: HlOrderWire[]; grouping: "na" }
  | { type: "cancel"; cancels: { a: number; o: number }[] }
  | { type: "updateLeverage"; asset: number; isCross: boolean; leverage: number };

const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(["order", "cancel", "updateLeverage"]);

/** L1 action hash: keccak(msgpack(action) || nonce u64 BE || 0x00 (no vault)). */
export function actionHash(action: HlAction, nonce: number): Hex {
  return keccak256(concat([msgpack(action), numberToHex(BigInt(nonce), { size: 8 }), "0x00"]));
}

/** Signs only order, cancel and updateLeverage (phantom agent, EIP-712 domain "Exchange" v1, chain 1337). */
export class HlSigner {
  private readonly account;
  constructor(key: Hex, readonly network: HlNetwork) { this.account = privateKeyToAccount(key); }
  get address(): Hex { return this.account.address; }
  async sign(action: HlAction, nonce: number): Promise<{ action: HlAction; nonce: number; signature: { r: Hex; s: Hex; v: number }; vaultAddress: null }> {
    if (!ALLOWED_ACTIONS.has(action.type)) throw new Error(`hyperliquid signer refuses action ${(action as { type: string }).type}`);
    const sig = await this.account.signTypedData({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent",
      message: { source: this.network === "mainnet" ? "a" : "b", connectionId: actionHash(action, nonce) },
    });
    const bytes = toBytes(sig);
    return { action, nonce, signature: { r: sig.slice(0, 66) as Hex, s: `0x${sig.slice(66, 130)}` as Hex, v: bytes[64]! }, vaultAddress: null };
  }
}

// ------------------------------------------------------------------------------------------------------------ venue
export interface HyperliquidVenueOptions {
  http: HlHttp;
  network: HlNetwork;
  /** the master account whose positions the agent trades (read side) */
  account: Hex;
  signer?: HlSigner;
  /** underlyings the hedger lists (symbols); only route-table coins are resolved */
  symbols: readonly string[];
  now?: () => number;
}

const toWadPx = (px: number): bigint => BigInt(Math.round(px * 1e6)) * 10n ** 12n;
const usdNum = (raw: bigint): number => Number(raw) / 1e6;
const toRawUsd = (n: number): bigint => BigInt(Math.round(n * 1e6));

export class HyperliquidVenue implements IHedgeVenue {
  readonly name = "hyperliquid" as const;
  readonly postsEquity = true;
  readonly fundable = false;
  private assets = new Map<string, HlAsset>();
  private resolvedAt = 0;
  private readonly now: () => number;
  constructor(private readonly o: HyperliquidVenueOptions) { this.now = o.now ?? (() => Date.now()); }

  readonly basis = (underlying: string) => {
    const r = hlRoute(this.o.network, underlying);
    return r?.proxy ? { proxy: true, note: `${underlying} hedged on ${r.coin}` } : { proxy: false };
  };

  /** Re-resolves the route-table coins at most every 10 minutes. */
  async refresh(force = false): Promise<void> {
    if (!force && this.assets.size && this.now() - this.resolvedAt < 600_000) return;
    const coins = this.o.symbols.map((s) => hlRoute(this.o.network, s)?.coin).filter((c): c is string => Boolean(c));
    this.assets = await resolveAssets(this.o.http, coins);
    this.resolvedAt = this.now();
  }

  /** The resolved asset for a symbol, only if its live name matches the route table. */
  asset(underlying: string): HlAsset | undefined {
    const route = hlRoute(this.o.network, underlying);
    if (!route) return undefined;
    const a = this.assets.get(route.coin);
    return a && a.coin === route.coin ? a : undefined;
  }

  canTrade(underlying: string): boolean { return this.asset(underlying) !== undefined; } // 24/7 perps

  private async book(underlying: string): Promise<HlBook> {
    const a = this.asset(underlying);
    if (!a) throw new Error(`hyperliquid: no route-table market for ${underlying}`);
    const l2 = (await this.o.http.post("/info", { type: "l2Book", coin: a.coin })) as { levels?: [HlLevel[], HlLevel[]] };
    return bookFromL2(l2.levels);
  }

  async markPrice(underlying: string): Promise<{ px: bigint; ageMs: number }> {
    const b = await this.book(underlying);
    if (b.mid === null) throw new Error(`hyperliquid: ${underlying} book has an empty side; no price`);
    return { px: toWadPx(b.mid), ageMs: 0 };
  }

  async maxTradeUsd(underlying: string, side: "buy" | "sell"): Promise<bigint> {
    const b = await this.book(underlying);
    if (b.mid === null) return 0n;
    return toRawUsd(side === "buy" ? b.askDepthUsd : b.bidDepthUsd);
  }

  private async state(dex: string) {
    return (await this.o.http.post("/info", { type: "clearinghouseState", user: this.o.account, ...(dex ? { dex } : {}) })) as {
      marginSummary?: { accountValue: string };
      assetPositions?: { position: { coin: string; szi: string; positionValue?: string } }[];
    };
  }

  async netPositionUsd(underlying: string): Promise<bigint> {
    const a = this.asset(underlying);
    if (!a) return 0n;
    const dex = a.coin.includes(":") ? a.coin.split(":")[0]! : "";
    const s = await this.state(dex);
    const pos = s.assetPositions?.find((p) => p.position.coin === a.coin)?.position;
    if (!pos || Number(pos.szi) === 0) return 0n;
    const b = await this.book(underlying);
    if (b.mid === null) throw new Error(`hyperliquid: ${underlying} has a position but no price`);
    return toRawUsd(Number(pos.szi) * b.mid);
  }

  async marginEquityUsd(): Promise<bigint> {
    const dexes = new Set([...this.assets.keys()].map((c) => (c.includes(":") ? c.split(":")[0]! : "")));
    let total = 0;
    for (const dex of dexes.size ? dexes : new Set([""])) total += Number((await this.state(dex)).marginSummary?.accountValue ?? 0);
    return toRawUsd(total);
  }

  async healthy(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.refresh();
      if (!this.assets.size) return { ok: false, reason: "no route-table market resolved" };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async fillByClientId(_underlying: string, clientId: string): Promise<VenueFill | null> {
    const r = (await this.o.http.post("/info", { type: "orderStatus", user: this.o.account, oid: clientId })) as {
      status?: string; order?: { status?: string; order?: { side?: string; origSz?: string; sz?: string; limitPx?: string; oid?: number } };
    };
    if (r.status !== "order" || !r.order?.order) return null;
    const o = r.order.order;
    const filledSz = Number(o.origSz ?? 0) - Number(o.sz ?? 0);
    if (!(filledSz > 0)) return null;
    const px = Number(o.limitPx ?? 0); // the limit is the worst price; the exact average comes from userFills in reconcile
    const sign = o.side === "A" ? -1 : 1;
    return { ref: String(o.oid ?? clientId), filledUsd: toRawUsd(sign * filledSz * px), avgPx: toWadPx(px), feesUsd: 0n };
  }

  async trade(underlying: string, deltaUsd: bigint, opts: { maxSlippageBps: number; clientId: string }): Promise<VenueFill> {
    if (!this.o.signer) throw new Error("hyperliquid: no signer configured");
    const a = this.asset(underlying);
    if (!a) throw new Error(`hyperliquid: no route-table market for ${underlying}`);
    const b = await this.book(underlying);
    if (b.mid === null) throw new Error(`hyperliquid: ${underlying} book has an empty side; no price`);
    const buy = deltaUsd > 0n;
    const limit = b.mid * (buy ? 1 + opts.maxSlippageBps / 10_000 : 1 - opts.maxSlippageBps / 10_000);
    const sz = sizeToWire(Math.abs(usdNum(deltaUsd)) / b.mid, a.szDecimals);
    if (Number(sz) === 0) return { ref: "", filledUsd: 0n, avgPx: toWadPx(b.mid), feesUsd: 0n };
    const action: HlAction = { type: "order", orders: [{ a: a.asset, b: buy, p: priceToWire(limit, a.szDecimals), s: sz, r: false, t: { limit: { tif: "Ioc" } }, c: opts.clientId as Hex }], grouping: "na" };
    const res = (await this.o.http.post("/exchange", await this.o.signer.sign(action, this.now()))) as {
      status: string; response?: { data?: { statuses?: ({ filled?: { totalSz: string; avgPx: string; oid: number } } | { error: string } | string)[] } };
    };
    if (res.status !== "ok") throw new Error(`hyperliquid: order refused: ${JSON.stringify(res).slice(0, 200)}`);
    const st = res.response?.data?.statuses?.[0];
    if (st && typeof st === "object" && "error" in st) throw new Error(`hyperliquid: ${st.error}`);
    if (!st || typeof st !== "object" || !("filled" in st) || !st.filled) return { ref: "", filledUsd: 0n, avgPx: toWadPx(b.mid), feesUsd: 0n };
    const filled = Number(st.filled.totalSz) * Number(st.filled.avgPx);
    return { ref: String(st.filled.oid), filledUsd: toRawUsd(buy ? filled : -filled), avgPx: toWadPx(Number(st.filled.avgPx)), feesUsd: 0n };
  }
}

/** WAD price helpers kept next to the venue for the scripts. */
export const wadPxToNumber = (px: bigint): number => Number((px * 1_000_000n) / WAD) / 1e6;
export const rawUsdToWad = (raw: bigint): bigint => raw * USDG_TO_WAD;
