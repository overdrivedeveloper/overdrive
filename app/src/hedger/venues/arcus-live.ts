// Live Arcus port (R15). Arcus perps are an off-chain order book with a REST API (docs.arcus.xyz, api-reference). Every
// host, path, field and enum below cites the docs page it comes from or a public GET recorded in
// docs/research/arcus-api.md and app/test/fixtures/arcus/ (2026-11-16). Nothing is invented.
// - Reads (markets, prices, book, account, positions, orders) are public GETs: no auth header (get-account, get-positions).
// - Orders are signed with an Ed25519 API key, Scheme 1 typed payload (api-reference/authentication). The signer builds
//   exactly two payloads, place (op 1) and cancel (op 2); it has no code path for transfer (op 6) or withdraw (op 5).
// - Deposits are refused: the docs document no on-chain USDG deposit for mainnet (guides/deposit-onchain: "deposit USDG
//   through the app"), so collateral is the owner's runbook, like Hyperliquid (R13).
// - placeOrder is asynchronous (202 ACK, exchange/place-order); the port polls GET /v1/order/{orderId} until a terminal
//   status. A POST is retried only on 429 (rejected before the handler, api-reference/rate-limits); any other failure is
//   "outcome unknown" and the service reconciles by client id instead of sending again.
import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { USDG_TO_WAD } from "../../lib/fixed";
import type { VenueFill } from "../types";
import type { ArcusPort } from "./arcus";

export type ArcusNetwork = "mainnet" | "testnet";

/** api-reference/introduction and authentication; GET /health answered {"status":"ok"} on both on 2026-11-16. */
export const ARCUS_API_URL: Record<ArcusNetwork, string> = { mainnet: "https://api.arcus.xyz", testnet: "https://api.testnet.arcus.xyz" };

// ------------------------------------------------------------------------------------------------------------ decimals
const D18 = 10n ** 18n;

/** Exact decimal string to an integer scaled by 10^18 (no floats). Throws on anything that is not a plain decimal. */
export function dec18(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`arcus: not a decimal: ${s.slice(0, 40)}`);
  const frac = (m[3] ?? "").slice(0, 18).padEnd(18, "0");
  const v = BigInt(m[2]!) * D18 + BigInt(frac);
  return m[1] ? -v : v;
}

/** An integer scaled by 10^18 back to a trimmed decimal string. */
export function fmt18(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / D18).toString();
  const frac = (a % D18).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// ------------------------------------------------------------------------------------------------------------ http
export type ArcusFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number; headers?: { get(name: string): string | null }; text(): Promise<string>;
}>;

export interface ArcusHttpOptions { baseUrl: string; fetch?: ArcusFetch; sleep?: (ms: number) => Promise<void>; now?: () => number; paceMs?: number }

export class ArcusHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ArcusHttpError"; }
}
/** A write whose outcome is not known (network error, 5xx, no terminal status in time). Never retried blindly. */
export class ArcusOutcomeUnknown extends Error {
  constructor(message: string) { super(message); this.name = "ArcusOutcomeUnknown"; }
}

/** Paced JSON client. Per-IP budget is 1,500 weight per minute (rate-limits); 250 ms pacing stays far below it. */
export class ArcusHttp {
  private last = Number.NEGATIVE_INFINITY;
  private readonly fetchFn: ArcusFetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly paceMs: number;
  constructor(private readonly o: ArcusHttpOptions) {
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
    this.paceMs = o.paceMs ?? 250;
  }

  private async pace(): Promise<void> {
    const wait = this.last + this.paceMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }

  /** 429 waits Retry-After (or retryAfterMs); 5xx and network errors back off 1 s doubling to 30 s; 8 tries. */
  private static retryDelay(status: number, headerSecs: string | null | undefined, body: string, fallback: number): number {
    if (status !== 429) return fallback;
    try { const ms = (JSON.parse(body) as { retryAfterMs?: number }).retryAfterMs; if (typeof ms === "number" && ms > 0) return ms; } catch { /* plain body */ }
    const s = Number(headerSecs);
    return Number.isFinite(s) && s > 0 ? s * 1000 : fallback;
  }

  /** GET; returns null on 404 when allow404 (GET /v1/account answers 404 "this account has no activity yet"). */
  async get<T>(path: string, query: Record<string, string | number> = {}, allow404 = false): Promise<T | null> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.o.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    let delay = 1_000;
    for (let attempt = 1; ; attempt++) {
      await this.pace();
      let status = 0; let body = ""; let retryAfter: string | null | undefined;
      try {
        const res = await this.fetchFn(url, { method: "GET", headers: { accept: "application/json" } });
        status = res.status; body = await res.text(); retryAfter = res.headers?.get("retry-after");
        if (status >= 200 && status < 300) return JSON.parse(body) as T;
        if (status === 404 && allow404) return null;
        if (status !== 429 && status < 500) throw new ArcusHttpError(`arcus GET ${path} HTTP ${status}: ${body.slice(0, 200)}`, status);
      } catch (error) {
        if (error instanceof ArcusHttpError) throw error;
        if (error instanceof SyntaxError) throw new ArcusHttpError(`arcus GET ${path}: response is not JSON`, status);
        status = 0;
      }
      if (attempt >= 8) throw new ArcusHttpError(`arcus GET ${path} failed after ${attempt} tries (last HTTP ${status})`, status);
      await this.sleep(ArcusHttp.retryDelay(status, retryAfter, body, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  /** Signed POST with a pre-serialised body. Only 429 is retried; anything else that is not a 2xx or 4xx is unknown. */
  async post<T>(path: string, body: string, headers: Record<string, string>): Promise<{ status: number; json: T }> {
    for (let attempt = 1; ; attempt++) {
      await this.pace();
      let res;
      try {
        res = await this.fetchFn(`${this.o.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      } catch (error) {
        throw new ArcusOutcomeUnknown(`arcus POST ${path}: no response (${error instanceof Error ? error.name : "error"}); reconcile by client id`);
      }
      const text = await res.text();
      if (res.status === 429 && attempt < 8) { await this.sleep(ArcusHttp.retryDelay(429, res.headers?.get("retry-after"), text, 1_000)); continue; }
      if (res.status >= 500) throw new ArcusOutcomeUnknown(`arcus POST ${path} HTTP ${res.status}; reconcile by client id`);
      if (res.status < 200 || res.status >= 300) throw new ArcusHttpError(`arcus POST ${path} HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      return { status: res.status, json: JSON.parse(text) as T };
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ signer
/** Scheme 1 place payload fields (authentication: "Canonical payload", keys in fixed alphabetical order). */
export interface ArcusPlaceFields { ad: string; ai: number; c?: string; ct: bigint; g: bigint; m: number; p: bigint; q: bigint; r: 0 | 1; s: 0 | 1; t: 0 | 1 | 2 | 3 }
export interface ArcusCancelFields { ad: string; ai: number; c?: string; ct: bigint; id?: string; m: number }

const CLIENT_ID = /^[A-Za-z0-9_-]{1,36}$/; // exchange/place-order clientId: charset and 1-36 chars
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** {"ad":..,"ai":..,"c":..,"ct":..,"g":..,"m":..,"op":1,"p":..,"q":..,"r":..,"s":..,"t":..,"v":1}; c omitted when empty. */
export function placePayload(f: ArcusPlaceFields): string {
  if (!ADDRESS.test(f.ad)) throw new Error("arcus: bad address");
  if (f.c !== undefined && f.c !== "" && !CLIENT_ID.test(f.c)) throw new Error("arcus: client id must match [A-Za-z0-9_-]{1,36}");
  const c = f.c ? `"c":"${f.c}",` : "";
  return `{"ad":"${f.ad.toLowerCase()}","ai":${f.ai},${c}"ct":${f.ct},"g":${f.g},"m":${f.m},"op":1,"p":${f.p},"q":${f.q},"r":${f.r},"s":${f.s},"t":${f.t},"v":1}`;
}

/** {"ad":..,"ai":..,"c":..,"ct":..,"id":..,"m":..,"op":2,"v":1}; exactly one of id or c. */
export function cancelPayload(f: ArcusCancelFields): string {
  if (!ADDRESS.test(f.ad)) throw new Error("arcus: bad address");
  if (Boolean(f.id) === Boolean(f.c)) throw new Error("arcus: cancel needs exactly one of id or client id");
  if (f.c && !CLIENT_ID.test(f.c)) throw new Error("arcus: client id must match [A-Za-z0-9_-]{1,36}");
  const c = f.c ? `"c":"${f.c}",` : "";
  const id = f.id ? `"id":"${f.id}",` : "";
  return `{"ad":"${f.ad.toLowerCase()}","ai":${f.ai},${c}"ct":${f.ct},${id}"m":${f.m},"op":2,"v":1}`;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex"); // RFC 8410 prefix for a raw 32-byte seed

/** Ed25519 API-key signer. Signs only place and cancel payloads. The seed never leaves this object. */
export class ArcusSigner {
  readonly #key: KeyObject;
  readonly apiKey: string;
  constructor(seedHex: string) {
    const hex = seedHex.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("arcus: the API signing key must be 32 bytes of hex");
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
    this.apiKey = createPublicKey(this.#key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  }
  private raw(message: string): string { return edSign(null, Buffer.from(message, "utf8"), this.#key).toString("hex"); }
  signPlace(f: ArcusPlaceFields): { payload: string; signature: string } { const payload = placePayload(f); return { payload, signature: this.raw(payload) }; }
  signCancel(f: ArcusCancelFields): { payload: string; signature: string } { const payload = cancelPayload(f); return { payload, signature: this.raw(payload) }; }
  toJSON(): string { return `ArcusSigner(${this.apiKey})`; }
}

/** Reads the signing key from a file (owner-saved, chmod 600). Never from an env value, never logged. */
export function loadArcusSigner(path: string): ArcusSigner {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error("arcus: the API signing key file must be chmod 600");
  return new ArcusSigner(readFileSync(path, "utf8"));
}

// ------------------------------------------------------------------------------------------------------------ wire types
/** GET /v1/markets entry: only the fields this port reads (fixtures mainnet-markets.json). */
export interface ArcusMarket {
  marketId: number; marketDisplayName: string; baseAsset: string; quoteAsset: string; status: string; type: string;
  tickSize: string; stepSize: string; tickTiers?: { upToPrice?: string; tick: string }[];
  minOrderNotional: string; minOrderSize: string; maxOrderSize: string; markPrice: string;
}
interface ArcusOrder { orderId: string; clientId?: string; marketId: number; side: "BUY" | "SELL"; status: string; filledSize?: string; avgFillPrice?: string; price?: string }

const TERMINAL = new Set(["FILLED", "CANCELED", "MARGIN_CANCELED", "REJECTED", "ERROR", "LIQUIDATED", "ADL"]); // order-status enum

/** Tick for a price from tickTiers (the price must be a multiple of its band tick; the signed p always uses tickSize). */
export function tierTick18(m: Pick<ArcusMarket, "tickSize" | "tickTiers">, px18: bigint): bigint {
  for (const t of m.tickTiers ?? []) if (t.upToPrice === undefined || px18 <= dec18(t.upToPrice)) return dec18(t.tick);
  return dec18(m.tickSize);
}

/** The order an IOC hedge sends: quantity in steps (floored), limit snapped inward to the band tick. null = too small. */
export function orderWire(m: ArcusMarket, deltaUsd: bigint, markWad: bigint, limitWad: bigint): { s: 0 | 1; p: bigint; q: bigint; price: string; quantity: string } | null {
  const buy = deltaUsd > 0n;
  const step = dec18(m.stepSize);
  const tick = dec18(m.tickSize);
  const usd18 = (buy ? deltaUsd : -deltaUsd) * USDG_TO_WAD;
  let q = (usd18 * D18) / markWad / step;
  const maxQ = dec18(m.maxOrderSize) / step;
  if (q > maxQ) q = maxQ;
  const band = tierTick18(m, limitWad);
  const snapped = buy ? (limitWad / band) * band : ((limitWad + band - 1n) / band) * band; // never past the slippage bound
  if (snapped <= 0n || snapped % tick !== 0n) return null;
  const qty18 = q * step;
  if (q <= 0n || qty18 < dec18(m.minOrderSize) || (qty18 * snapped) / D18 < dec18(m.minOrderNotional)) return null;
  return { s: buy ? 0 : 1, p: snapped / tick, q, price: fmt18(snapped), quantity: fmt18(qty18) };
}

// ------------------------------------------------------------------------------------------------------------ port
export interface LiveArcusOptions {
  http: ArcusHttp;
  /** master wallet address the API key is registered to (createApiKey) */
  account: string;
  accountIndex: number;
  /** absent in dry run: the port then reads only and refuses any order */
  signer?: ArcusSigner;
  /** IOC terminal-status wait (ms) */
  settleMs?: number;
}

const GOOD_TIL_US = 40n * 86_400n * 1_000_000n; // >= one month ahead is required even for IOC (place-order goodTilTime)

export class LiveArcusPort implements ArcusPort {
  private byBase = new Map<string, ArcusMarket>();
  private lastCt = 0n;
  constructor(private readonly o: LiveArcusOptions) {
    if (!ADDRESS.test(o.account)) throw new Error("arcus: account address is not set");
    if (!Number.isInteger(o.accountIndex) || o.accountIndex < 0 || o.accountIndex > 9) throw new Error("arcus: accountIndex must be 0..9");
  }
  private get q() { return { address: this.o.account, accountIndex: this.o.accountIndex }; }

  private async loadMarkets(): Promise<Map<string, ArcusMarket>> {
    const r = await this.o.http.get<{ markets: ArcusMarket[] }>("/v1/markets");
    const out = new Map<string, ArcusMarket>();
    for (const m of r?.markets ?? []) if (m.type === "PERPETUAL" && m.quoteAsset === "USD") out.set(m.baseAsset, m);
    this.byBase = out;
    return out;
  }
  private async market(u: string): Promise<ArcusMarket> {
    const m = this.byBase.get(u) ?? (await this.loadMarkets()).get(u);
    if (!m) throw new Error(`arcus: no perp market for ${u}`);
    return m;
  }

  /** Open = status ONLINE (get-markets: OFFLINE markets are listed but do not trade). RWA perps trade 24/7 with off-hours bands. */
  async markets(): Promise<Map<string, { open: boolean; proxy: boolean }>> {
    const all = await this.loadMarkets();
    return new Map([...all].map(([u, m]) => [u, { open: m.status === "ONLINE", proxy: false }]));
  }

  async positionUnits(u: string): Promise<bigint> {
    const m = await this.market(u);
    const r = await this.o.http.get<{ positions: Record<string, { marketId: number; size: string }> }>("/v1/positions", this.q);
    const p = r?.positions?.[String(m.marketId)];
    return p ? dec18(p.size) : 0n; // size is signed base units (get-positions; fixture testnet-positions.json)
  }

  async equityUsd(): Promise<bigint> {
    const r = await this.o.http.get<{ equity: string }>("/v1/account", this.q, true);
    if (!r) return 0n; // 404: no activity yet (authentication, "Your testnet account")
    return dec18(r.equity) / USDG_TO_WAD;
  }

  async mark(u: string): Promise<{ px: bigint; updatedAtMs: number }> {
    const m = await this.market(u);
    const at = this.o.http.now();
    const r = await this.o.http.get<Record<string, { markPrice: string }>>("/v1/prices");
    const px = r?.[String(m.marketId)]?.markPrice;
    if (!px) throw new Error(`arcus: no mark for ${u}`);
    const v = dec18(px);
    if (v <= 0n) throw new Error(`arcus: non-positive mark for ${u}`);
    return { px: v, updatedAtMs: at };
  }

  /** Visible depth over 20 levels on the side a trade would take (buy takes asks), raw USDG. */
  async depthUsd(u: string, side: "buy" | "sell"): Promise<bigint> {
    const m = await this.market(u);
    const r = await this.o.http.get<{ bids: [string, string][]; asks: [string, string][] }>(`/v1/l2OrderBook/${encodeURIComponent(m.marketDisplayName)}`, { nLevels: 20 });
    const levels = (side === "buy" ? r?.asks : r?.bids) ?? [];
    let usd18 = 0n;
    for (const [px, sz] of levels) usd18 += (dec18(px) * dec18(sz)) / D18;
    return usd18 / USDG_TO_WAD;
  }

  private nextCt(): bigint {
    const ct = BigInt(Math.floor(this.o.http.now())) * 1_000_000n;
    this.lastCt = ct > this.lastCt ? ct : this.lastCt + 1n;
    return this.lastCt;
  }

  async placeOrder(u: string, deltaUsd: bigint, limitPx: bigint, clientId: string): Promise<VenueFill> {
    if (!this.o.signer) throw new Error("arcus: no signer configured (dry run or no ARCUS_API_SIGNING_KEY_FILE)");
    if (!CLIENT_ID.test(clientId)) throw new Error("arcus: client id must match [A-Za-z0-9_-]{1,36}");
    const m = await this.market(u);
    const mark = (await this.mark(u)).px;
    const w = orderWire(m, deltaUsd, mark, limitPx);
    if (!w) return { ref: "", filledUsd: 0n, avgPx: mark, feesUsd: 0n };
    const ct = this.nextCt();
    const goodTilUs = BigInt(Math.floor(this.o.http.now())) * 1_000n + GOOD_TIL_US;
    const { signature } = this.o.signer.signPlace({ ad: this.o.account, ai: this.o.accountIndex, c: clientId, ct, g: goodTilUs * 1_000n, m: m.marketId, p: w.p, q: w.q, r: 0, s: w.s, t: 2 });
    // Body per exchange/place-order OrderRequest; timestamp is an int64 nanosecond literal (beyond 2^53, so not JSON.stringify).
    const body = `{"accountIndex":${this.o.accountIndex},"address":"${this.o.account}","clientId":"${clientId}","goodTilTime":"${goodTilUs}","marketId":${m.marketId},"orderSide":"${w.s === 0 ? "BUY" : "SELL"}","orderType":"LIMIT","price":"${w.price}","quantity":"${w.quantity}","reduceOnly":false,"timeInForce":"IOC","timestamp":${ct}}`;
    const placed = await this.o.http.post<{ orderId?: string; status?: string }>(`/v1/placeOrder?address=${this.o.account}`, body, { "X-API-Key": this.o.signer.apiKey, "X-Timestamp": String(ct), "X-Signature": signature });
    const orderId = placed.json.orderId;
    if (!orderId) throw new ArcusOutcomeUnknown("arcus: placeOrder returned no orderId; reconcile by client id");
    const deadline = this.o.http.now() + (this.o.settleMs ?? 5_000);
    for (;;) {
      const o = await this.o.http.get<ArcusOrder>(`/v1/order/${encodeURIComponent(orderId)}`, this.q, true);
      if (o && TERMINAL.has(o.status)) return toFill(o, mark);
      if (this.o.http.now() >= deadline) throw new ArcusOutcomeUnknown(`arcus: order ${orderId} not terminal in time; reconcile by client id`);
      await this.o.http.sleep(250);
    }
  }

  /** R10: the newest order with this client id (GET /v1/orders, newest-first); null when never seen or nothing filled. */
  async orderByClientId(clientId: string): Promise<VenueFill | null> {
    const r = await this.o.http.get<{ orders: ArcusOrder[] }>("/v1/orders", { ...this.q, limit: 100 });
    const o = r?.orders?.find((x) => x.clientId === clientId);
    if (!o) return null;
    const f = toFill(o, 0n);
    return f.filledUsd === 0n ? null : f;
  }

  async deposit(_usd: bigint): Promise<void> {
    throw new Error("arcus: deposits are the owner's runbook (no on-chain USDG deposit is documented for mainnet; use the app)");
  }

  async healthy(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const h = await this.o.http.get<{ status?: string }>("/health");
      if (h?.status !== "ok") return { ok: false, reason: "arcus /health not ok" };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

function toFill(o: ArcusOrder, fallbackPx: bigint): VenueFill {
  const size = o.filledSize ? dec18(o.filledSize) : 0n;
  const abs = size < 0n ? -size : size;
  const px = o.avgFillPrice ? dec18(o.avgFillPrice) : fallbackPx;
  if (abs === 0n || px === 0n) return { ref: o.orderId, filledUsd: 0n, avgPx: px, feesUsd: 0n };
  const usd = (abs * px) / D18 / USDG_TO_WAD;
  return { ref: o.orderId, filledUsd: o.side === "SELL" ? -usd : usd, avgPx: px, feesUsd: 0n }; // fees: GET /v1/fills in reconcile
}

