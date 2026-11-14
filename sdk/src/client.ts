import type { Operations } from "./generated.js";

type Response200<K extends keyof Operations> = Operations[K]["responses"] extends { 200: infer R } ? R : never;

/** Every non-2xx answer becomes one of these; `code` is the API's own error code (for example `RATE_LIMITED`, `CLOSED`). */
export class OverdriveApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Why a quote or buy is blocked, when the API says so. */
    readonly reason?: string,
    message?: string,
    /** Seconds to wait, from `Retry-After`, on a 429 or 503. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message ?? code);
    this.name = "OverdriveApiError";
  }
}

/** The request allowance the API reported on the latest response (IETF draft RateLimit headers). */
export interface RateLimitInfo { readonly limit: number; readonly remaining: number; readonly resetSeconds: number }

export interface ClientOptions {
  /** API host, for example `https://api.example.com` (no trailing path). */
  readonly baseUrl: string;
  /** Replace `fetch` (tests, proxies, older runtimes). */
  readonly fetch?: typeof fetch;
  /** Per-request timeout. Default 15000. */
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
  /** Wait and retry when the API answers 429. Default 2 tries after the first, never waiting longer than `maxRetryWaitSeconds` (default 10). */
  readonly retries?: number;
  readonly maxRetryWaitSeconds?: number;
  /** Keep ETags and answer repeat reads from memory when the API says 304. Default true. */
  readonly revalidate?: boolean;
  /**
   * The Overdrive contract addresses you expect (name -> address, as in /v1/config `contracts`). Every intent's target and
   * every approval spender must be one of them, or `intent()` throws `OverdriveIntentMismatch` before you sign anything.
   * Without them the client checks against the API's own /v1/config.
   */
  readonly expectedContracts?: Readonly<Record<string, string>>;
  /** Check intent targets and spenders. Default true; turn off only in tests. */
  readonly checkIntents?: boolean;
}

/** An intent whose target or approval spender is not an Overdrive contract. Nothing was signed or sent. */
export class OverdriveIntentMismatch extends Error {
  constructor(message: string, readonly field: string, readonly address: string) {
    super(message);
    this.name = "OverdriveIntentMismatch";
  }
}

export type Range = "1d" | "7d" | "30d" | "90d";
export type QuoteQuery = Operations["GET /v1/quote"]["query"];
export type QuoteResponse = Response200<"GET /v1/quote">;
export type GearsQuery = never;
export type IntentKind = "buy" | "sell";
export type IntentBody<K extends IntentKind> = Operations[`POST /v1/intent/${K}`]["body"];
export type IntentResponse<K extends IntentKind> = Response200<`POST /v1/intent/${K}`>;

const enc = encodeURIComponent;
function queryString(query: Record<string, string | number | undefined>): string {
  const parts = Object.entries(query).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "").map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Overdrive {
  private readonly base: string;
  private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly cache = new Map<string, { etag: string; body: unknown }>();
  private rate: RateLimitInfo | null = null;

  constructor(private readonly options: ClientOptions) {
    if (!options.baseUrl) throw new TypeError("baseUrl is required");
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.doFetch = options.fetch ? (input, init) => options.fetch!(input, init) : (input, init) => globalThis.fetch(input, init);
  }

  /** The allowance reported by the most recent response, or null before the first one. */
  get rateLimit(): RateLimitInfo | null { return this.rate; }

  // ------------------------------------------------------------------ system
  health() { return this.get<Response200<"GET /health">>("/health"); }
  config() { return this.get<Response200<"GET /v1/config">>("/v1/config"); }
  status() { return this.get<Response200<"GET /v1/status">>("/v1/status"); }
  /** The OpenAPI 3.1 document this client was generated from. */
  openapi() { return this.get<Record<string, unknown>>("/openapi.json"); }

  // ------------------------------------------------------------------ gears and tolls (`stale` is returned, never thrown)
  gears() { return this.get<Response200<"GET /v1/gears">>("/v1/gears"); }
  /** One gear by symbol (`TSLA-SPORT`) or id. */
  gear(id: string) { return this.get<Response200<"GET /v1/gears/{id}">>(`/v1/gears/${enc(id)}`); }
  gearHistory(id: string, query: { range?: Range } = {}) { return this.get<Response200<"GET /v1/gears/{id}/history">>(`/v1/gears/${enc(id)}/history${queryString(query)}`); }
  /** The daily toll of every gear. */
  tolls() { return this.get<Response200<"GET /v1/tolls">>("/v1/tolls"); }
  tollFormula() { return this.get<Response200<"GET /v1/tolls/formula">>("/v1/tolls/formula"); }

  // ------------------------------------------------------------------ quotes and intents (nothing is sent on chain)
  /** Exact quote: the amounts are what the hook executes. `buyable` says whether it runs now; `reason` says why not. */
  quote(query: QuoteQuery) { return this.get<QuoteResponse>(`/v1/quote${queryString(query as Record<string, string>)}`); }
  /** Unsigned transaction data and the exact approval for a buy or sell. Sign it with your own wallet. */
  async intent<K extends IntentKind>(kind: K, body: IntentBody<K>): Promise<IntentResponse<K>> {
    const result = await this.send<IntentResponse<K>>("POST", `/v1/intent/${kind}`, body);
    if (this.options.checkIntents !== false) await this.checkIntent(result as { tx?: { to?: string }; approvals?: Array<{ spender?: string }> });
    return result;
  }

  /** Throws unless the intent's target and every approval spender is a known Overdrive contract. */
  private async checkIntent(intent: { tx?: { to?: string }; approvals?: Array<{ spender?: string }> }): Promise<void> {
    const known = this.options.expectedContracts ?? (await this.config()).contracts;
    const allowed = new Set(Object.values(known ?? {}).filter((v): v is string => typeof v === "string" && v !== "").map((v) => v.toLowerCase()));
    const check = (field: string, address: unknown) => {
      if (typeof address !== "string" || !allowed.has(address.toLowerCase())) throw new OverdriveIntentMismatch(`Intent ${field} ${String(address)} is not an Overdrive contract. Do not sign it.`, field, String(address));
    };
    check("tx.to", intent.tx?.to);
    for (const [index, approval] of (intent.approvals ?? []).entries()) check(`approvals[${index}].spender`, approval.spender);
  }

  // ------------------------------------------------------------------ the Governor, exit reserve and risk
  governor() { return this.get<Response200<"GET /v1/governor">>("/v1/governor"); }
  governorHistory(query: { range?: Range } = {}) { return this.get<Response200<"GET /v1/governor/history">>(`/v1/governor/history${queryString(query)}`); }
  exit() { return this.get<Response200<"GET /v1/exit">>("/v1/exit"); }
  fees() { return this.get<Response200<"GET /v1/fees">>("/v1/fees"); }
  risk() { return this.get<Response200<"GET /v1/risk">>("/v1/risk"); }
  hedges() { return this.get<Response200<"GET /v1/hedges">>("/v1/hedges"); }

  // ------------------------------------------------------------------ accounts
  account(address: string) { return this.get<Response200<"GET /v1/account/{address}">>(`/v1/account/${enc(address)}`); }
  backer(address: string) { return this.get<Response200<"GET /v1/backers/{address}">>(`/v1/backers/${enc(address)}`); }
  vault(id: string | number | bigint) { return this.get<Response200<"GET /v1/vaults/{id}">>(`/v1/vaults/${enc(String(id))}`); }

  // ------------------------------------------------------------------ plumbing
  private get<T>(path: string): Promise<T> { return this.send<T>("GET", path); }

  private async send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const useCache = method === "GET" && this.options.revalidate !== false;
    const cached = useCache ? this.cache.get(path) : undefined;
    const response = await this.request(method, path, body, cached?.etag);
    if (response.status === 304 && cached) return cached.body as T;
    const json = (await response.json()) as T;
    const etag = response.headers.get("etag");
    if (useCache && etag) this.cache.set(path, { etag, body: json });
    return json;
  }

  private async request(method: string, path: string, body: unknown, etag?: string): Promise<Response> {
    const retries = this.options.retries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = { accept: "application/json", ...this.options.headers };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (etag) headers["if-none-match"] = etag;
      let response: Response;
      try {
        response = await this.doFetch(`${this.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new OverdriveApiError(0, timedOut ? "TIMEOUT" : "NETWORK", undefined, timedOut ? "The request timed out." : "The API could not be reached.");
      }
      this.readRate(response);
      if (response.ok || response.status === 304) return response;
      if (response.status === 429 && attempt < retries) {
        const wait = Number(response.headers.get("retry-after") ?? 1);
        if (Number.isFinite(wait) && wait <= (this.options.maxRetryWaitSeconds ?? 10)) { await sleep(Math.max(0, wait) * 1000); continue; }
      }
      throw await this.failure(response);
    }
  }

  private async failure(response: Response): Promise<OverdriveApiError> {
    let record: Record<string, unknown> = {};
    try { record = (await response.json()) as Record<string, unknown>; } catch { /* not JSON */ }
    const retry = Number(response.headers.get("retry-after"));
    return new OverdriveApiError(
      response.status, typeof record.error === "string" ? record.error : "UPSTREAM", typeof record.reason === "string" ? record.reason : undefined,
      typeof record.message === "string" ? record.message : `The API answered ${response.status}.`, Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }

  private readRate(response: Response): void {
    const limit = Number(response.headers.get("ratelimit-limit"));
    const remaining = Number(response.headers.get("ratelimit-remaining"));
    const reset = Number(response.headers.get("ratelimit-reset"));
    if (Number.isFinite(limit) && Number.isFinite(remaining) && response.headers.has("ratelimit-limit")) this.rate = { limit, remaining, resetSeconds: Number.isFinite(reset) ? reset : 0 };
  }
}
