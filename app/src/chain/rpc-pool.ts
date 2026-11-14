import { custom, http, type Transport } from "viem";
import type { RuntimeConfig } from "../config";
import { logger } from "../log";
import { utcDateKey } from "../lib/time";
import { robinhoodChain } from "./chain";

export type RpcCallClass = "logs" | "state" | "tx";
export type RpcEndpointKind = "alchemy" | "public" | "override" | "backup";

export interface RpcEndpointInfo {
  readonly id: string;
  readonly kind: RpcEndpointKind;
  readonly url: string;
}

export interface RpcRequest {
  readonly method: string;
  readonly params?: readonly unknown[];
}

export type RpcEndpointRequest = (request: RpcRequest) => Promise<unknown>;
export type RpcRequestFactory = (endpoint: RpcEndpointInfo) => RpcEndpointRequest;

interface Endpoint extends RpcEndpointInfo {
  readonly request: RpcEndpointRequest;
  coolUntil: number;
  failures: number;
  health: Health;
}

/** Rolling health of one endpoint. `successRate` and `latencyMs` are exponentially weighted so a few old calls cannot
 * hide a fresh outage, and a single slow call cannot condemn a good endpoint. */
interface Health {
  successRate: number;
  latencyMs: number | null;
  samples: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

interface Counters {
  requests: number;
  estimatedCu: number;
  cacheHits: number;
  errors: number;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number | null;
}

const CACHE_LIMIT = 10_000;
/** Weight of the newest call in the rolling success rate and latency. */
const HEALTH_ALPHA = 0.2;
/** Latency at which an endpoint loses a quarter of its score. */
const SLOW_LATENCY_MS = 2_000;
/** R9: a failing endpoint is skipped for 1 s, doubling per consecutive failure, capped at 30 s. */
const BASE_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 30_000;
/** Largest eth_getLogs block span each kind of secondary endpoint serves, measured 2026-10-28: Alchemy's free tier
 * allows 10 blocks, the default backup 2000. A custom backup URL is assumed to allow the default backup's 2000. The
 * official public RPC (and an override) has no cap here: it answers up to 100,000 blocks and the indexer halves its own
 * range on any refusal. */
export const LOGS_MAX_BLOCKS: Readonly<Partial<Record<RpcEndpointKind, bigint>>> = { alchemy: 10n, backup: 2000n };
/** A capped endpoint answers one eth_getLogs with at most this many sequential slices. A wider query is refused up front
 * with a range-limit error, so the indexer halves its range to cap x MAX_LOG_SLICES (Alchemy free: 50 blocks, backup:
 * 10,000) instead of hammering a free endpoint: measured on the default backup, 13 slices in a row drew rate limits,
 * 5 never did. */
export const MAX_LOG_SLICES = 5n;
const NO_DEDUPE_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_estimateGas",
  "eth_getTransactionCount",
]);
const CU_BY_METHOD: Readonly<Record<string, number>> = {
  eth_blockNumber: 10,
  eth_getLogs: 75,
  eth_call: 26,
  eth_estimateGas: 87,
  eth_sendRawTransaction: 250,
  eth_getTransactionReceipt: 15,
};

function defaultRequestFactory(
  endpoint: RpcEndpointInfo,
  fetchFn?: typeof fetch,
): RpcEndpointRequest {
  const transport = http(endpoint.url, {
    timeout: 8_000,
    retryCount: 0,
    batch: { batchSize: 20, wait: 20 },
    ...(fetchFn ? { fetchFn } : {}),
  })({ chain: robinhoodChain });

  return (request) => transport.request(request as never) as Promise<unknown>;
}

function safeSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function cacheKey(request: RpcRequest): string {
  return `${request.method}:${safeSerialize(request.params ?? [])}`;
}

function blockTag(params: readonly unknown[] | undefined): string | undefined {
  const tag = params?.[1];
  if (typeof tag === "string") return tag.toLowerCase();
  if (tag && typeof tag === "object") {
    const object = tag as { blockNumber?: unknown; blockTag?: unknown };
    if (typeof object.blockNumber === "bigint") return `0x${object.blockNumber.toString(16)}`;
    if (typeof object.blockNumber === "string") return object.blockNumber.toLowerCase();
    if (typeof object.blockTag === "string") return object.blockTag.toLowerCase();
  }
  return undefined;
}

const FEE_METHODS = new Set(["eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"]);

function cacheLifetime(callClass: RpcCallClass, request: RpcRequest): number | null | undefined {
  const { method, params } = request;
  if (NO_DEDUPE_METHODS.has(method)) return undefined;
  // Transactions must be priced from a fresh fee read: a stale cached price
  // gets broadcasts rejected after a base-fee rise.
  if (FEE_METHODS.has(method)) return callClass === "tx" ? undefined : 5_000;

  if (method === "eth_chainId" || method === "eth_getBlockByHash") return null;
  if (method === "eth_getCode") {
    const tag = blockTag(params);
    if (tag && /^0x[0-9a-f]+$/.test(tag)) return null;
    return tag === "latest" ? 1_000 : undefined;
  }
  // R9: a header by number is never cached (a reorg changes the answer, and the indexer compares hashes to see it).
  if (method === "eth_getBlockByNumber") return undefined;
  if (method === "eth_getTransactionReceipt") return null;
  if (method === "eth_call") {
    const tag = blockTag(params);
    if (tag && /^0x[0-9a-f]+$/.test(tag)) return null;
    if (tag === "latest") return 2_000;
    return undefined;
  }
  if (method === "eth_blockNumber") return 1_000;
  return undefined;
}

function shouldCacheResponse(request: RpcRequest, value: unknown): boolean {
  if (
    request.method === "eth_getTransactionReceipt" ||
    request.method === "eth_getBlockByNumber" ||
    request.method === "eth_getBlockByHash"
  ) {
    return value !== null && value !== undefined;
  }
  return true;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let i = 0; i < 8 && current !== undefined && current !== null; i += 1) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function errorProperty(error: unknown, property: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[property];
}

function errorText(error: unknown): string {
  return errorChain(error)
    .map((item) => {
      const details = errorProperty(item, "details");
      if (item instanceof Error) return `${item.name} ${item.message}${typeof details === "string" ? ` ${details}` : ""}`;
      return String(item);
    })
    .join(" ")
    .toLowerCase();
}

function safeRpcError(error: unknown, secrets: readonly string[]): Error {
  const chain = errorChain(error);
  const message = chain
    .map((item) => {
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        // viem's long message carries the URL and the whole request body before the node's own words ("Details:"), so a
        // request with many addresses was cut at 1,000 characters before the reason, and the indexer could not tell a
        // block-range limit (which it answers by halving the range) from any other failure. Short message + details keeps
        // the reason (measured on the backup: "query exceeds max block range 2000").
        const short = typeof record.shortMessage === "string" ? record.shortMessage : undefined;
        const details = typeof record.details === "string" ? record.details : undefined;
        if (short && details && !short.includes(details)) return `${short} ${details}`;
        if (short) return short;
      }
      if (item instanceof Error) return item.message;
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (typeof record.message === "string") return record.message;
      }
      return "";
    })
    .find((candidate) => candidate.length > 0) ?? "RPC request failed";

  let sanitized = message.replace(/https?:\/\/[^\s)'"<>]+/gi, "[URL]");
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(
    /(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
  const safeError = new Error(sanitized.slice(0, 1_000));
  safeError.name = "RpcError";

  const code = chain
    .map((item) => errorProperty(item, "code"))
    .find((candidate): candidate is number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate),
    );
  const data = chain
    .map((item) => {
      const value = errorProperty(item, "data");
      if (typeof value === "string") return value;
      return errorProperty(value, "data");
    })
    .find(
      (candidate): candidate is string =>
        typeof candidate === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(candidate),
    );

  if (code !== undefined) Object.assign(safeError, { code });
  if (data !== undefined) Object.assign(safeError, { data });
  return safeError;
}

function isExecutionError(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const code = errorProperty(item, "code");
    const message = errorProperty(item, "shortMessage") ?? errorProperty(item, "message");
    return (
      (code === 3 || code === -32000) &&
      typeof message === "string" &&
      /execution reverted|revert|call exception/i.test(message)
    );
  });
}

function isTransientTransportError(error: unknown): boolean {
  if (isExecutionError(error)) return false;

  for (const item of errorChain(error)) {
    for (const key of ["status", "statusCode"]) {
      const status = errorProperty(item, key);
      if (typeof status === "number" && (status === 429 || status >= 500)) return true;
    }
  }

  const text = errorText(error);
  return (
    /\b429\b|\b5\d\d\b|timeout|timed out|network error|fetch failed|econn|socket hang up|connection reset|too many requests|rate limit/.test(
      text,
    ) ||
    // Measured on the official public RPC (2026-10-28): a rate-limited JSON-RPC BATCH gets HTTP 429 with a single error
    // object instead of an array, and viem reports only "Cannot destructure property 'error' ..." (no status). It is a
    // rate limit, so it must cool the endpoint and fail over like any other 429.
    /cannot destructure property 'error'/.test(text)
  );
}

function emptyCounters(): Counters {
  return { requests: 0, estimatedCu: 0, cacheHits: 0, errors: 0 };
}

function methodCu(method: string): number {
  return CU_BY_METHOD[method] ?? 20;
}

/** An eth_getLogs too wide for one endpoint's cap: refused before any call, so the next endpoint is tried; if no endpoint
 * can serve it, the caller gets this block-range limit (the indexer halves its range). */
class LogSpanTooWideError extends Error {
  readonly code = -32602;
  constructor(message: string) {
    super(message);
    this.name = "LogSpanTooWideError";
  }
}

function rpcError(message: string): Error {
  return new Error(message);
}

export interface RpcPoolOptions {
  readonly requestFactory?: RpcRequestFactory;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

export interface RpcEndpointStats {
  readonly id: string;
  readonly kind: RpcEndpointKind;
  readonly cooling: boolean;
  readonly coolDownMs: number;
  /** 0 to 100: rolling success rate, reduced for slow answers. 100 until the endpoint has been used. Reported only: it
   * never changes the order endpoints are tried in. */
  readonly score: number;
  readonly successRate: number;
  readonly latencyMs: number | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly classes: Readonly<Record<RpcCallClass, Counters>>;
}

export interface RpcFailoverStats {
  readonly backupConfigured: boolean;
  /** Endpoint that answered the most recent call. */
  readonly activeEndpoint: string | null;
  readonly usingBackup: boolean;
  /** Calls answered by an endpoint other than the first one tried. */
  readonly count: number;
  readonly backupCalls: number;
  readonly lastAt: string | null;
  readonly lastFrom: string | null;
  readonly lastTo: string | null;
}

export interface RpcPoolStats {
  readonly date: string;
  readonly failover: RpcFailoverStats;
  readonly endpoints: readonly RpcEndpointStats[];
  readonly classes: Readonly<Record<RpcCallClass, Counters>>;
}

export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly endpointCounters = new Map<string, Record<RpcCallClass, Counters>>();
  private readonly classCounters: Record<RpcCallClass, Counters> = {
    logs: emptyCounters(),
    state: emptyCounters(),
    tx: emptyCounters(),
  };
  private readonly now: () => number;
  private alchemyCursor = 0;
  private failoverCount = 0;
  private backupCalls = 0;
  private lastFailover: { at: number; from: string; to: string } | null = null;
  private activeEndpoint: string | null = null;
  private metricsDate = utcDateKey();
  private reportTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: RuntimeConfig, options: RpcPoolOptions = {}) {
    this.now = options.now ?? Date.now;
    const requestFactory =
      options.requestFactory ?? ((endpoint) => defaultRequestFactory(endpoint, options.fetchFn));
    if (config.RPC_URL_OVERRIDE.trim()) {
      this.endpoints = [
        this.makeEndpoint(
          { id: "override", kind: "override", url: config.RPC_URL_OVERRIDE.trim() },
          requestFactory,
        ),
      ];
    } else {
      const publicEndpoint = this.makeEndpoint(
        { id: "public", kind: "public", url: config.PUBLIC_RPC_URL },
        requestFactory,
      );
      const alchemyEndpoints = config.ALCHEMY_API_KEYS.map((key, index) =>
        this.makeEndpoint(
          {
            id: `alchemy#${index + 1}`,
            kind: "alchemy",
            url: config.ALCHEMY_URL_TEMPLATE.replace("{key}", key),
          },
          requestFactory,
        ),
      );
      this.endpoints = [publicEndpoint, ...alchemyEndpoints];
    }

    const backupUrl = (config.RPC_BACKUP_URL ?? "").trim();
    if (backupUrl) {
      this.endpoints.push(
        this.makeEndpoint({ id: "backup", kind: "backup", url: backupUrl }, requestFactory),
      );
    }

    for (const endpoint of this.endpoints) {
      this.endpointCounters.set(endpoint.id, {
        logs: emptyCounters(),
        state: emptyCounters(),
        tx: emptyCounters(),
      });
    }
  }

  private makeEndpoint(info: RpcEndpointInfo, requestFactory: RpcRequestFactory): Endpoint {
    return {
      ...info,
      request: requestFactory(info),
      coolUntil: 0,
      failures: 0,
      health: { successRate: 1, latencyMs: null, samples: 0, lastSuccessAt: null, lastFailureAt: null },
    };
  }

  private score(endpoint: Endpoint): number {
    const { successRate, latencyMs } = endpoint.health;
    const latencyFactor = latencyMs === null ? 1 : 1 / (1 + latencyMs / SLOW_LATENCY_MS);
    // A fast endpoint keeps its full success rate; a 2 s endpoint keeps three quarters of it.
    return Math.round(100 * successRate * (0.5 + 0.5 * latencyFactor) * 100) / 100;
  }

  private recordOutcome(endpoint: Endpoint, ok: boolean, latencyMs: number): void {
    const health = endpoint.health;
    health.samples += 1;
    health.successRate = health.successRate * (1 - HEALTH_ALPHA) + (ok ? 1 : 0) * HEALTH_ALPHA;
    if (ok) {
      health.latencyMs = health.latencyMs === null
        ? latencyMs
        : health.latencyMs * (1 - HEALTH_ALPHA) + latencyMs * HEALTH_ALPHA;
      health.lastSuccessAt = this.now();
    } else {
      health.lastFailureAt = this.now();
    }
  }

  /** The endpoints to try, in the configured order: the official public RPC (and any Alchemy keys) first, the backup
   * last. The order is never re-ranked by latency or health score (a lesson from an earlier launch: a fast-pinging backup that refused
   * the indexer's eth_getLogs sizes was ranked first and the indexer fell 400 to 1150 blocks behind). An endpoint that
   * just failed with a transport error cools down for a while and is skipped while a usable one is left; once its
   * cool-down ends it is tried first again, so the backup only ever answers while the main endpoints are failing. */
  private candidates(callClass: RpcCallClass): Endpoint[] {
    const route = this.route(callClass);
    const now = this.now();
    const available = route.filter((endpoint) => endpoint.coolUntil <= now);
    return available.length ? available : route;
  }

  private noteAnswer(endpoint: Endpoint, first: Endpoint | undefined, callCount: number): void {
    this.activeEndpoint = endpoint.id;
    if (endpoint.kind === "backup") this.backupCalls += callCount;
    if (first && first.id !== endpoint.id) {
      this.failoverCount += 1;
      this.lastFailover = { at: this.now(), from: first.id, to: endpoint.id };
      logger.warn({ from: first.id, to: endpoint.id }, "RPC failover: request answered by another endpoint");
    }
  }

  /** One call on one endpoint. An eth_getLogs wider than the endpoint's measured cap (LOGS_MAX_BLOCKS) is split into
   * consecutive slices inside the cap and the logs are joined in block order (a slice failure fails the whole call); a
   * query needing more than MAX_LOG_SLICES slices is refused as a block-range limit without calling the endpoint. */
  private async send(endpoint: Endpoint, request: RpcRequest): Promise<unknown> {
    const cap = LOGS_MAX_BLOCKS[endpoint.kind];
    const filter = request.method === "eth_getLogs" ? (request.params?.[0] as Record<string, unknown> | undefined) : undefined;
    if (!cap || !filter || typeof filter.fromBlock !== "string" || typeof filter.toBlock !== "string" || !/^0x[0-9a-f]+$/i.test(filter.fromBlock) || !/^0x[0-9a-f]+$/i.test(filter.toBlock)) {
      return endpoint.request(request);
    }
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    const span = to - from + 1n;
    if (span <= cap) return endpoint.request(request);
    const slices = (span + cap - 1n) / cap;
    if (slices > MAX_LOG_SLICES) {
      throw new LogSpanTooWideError(`query spans ${span} blocks, but the ${endpoint.kind} endpoint serves at most ${cap * MAX_LOG_SLICES} blocks per call (${cap}-block slices); narrow the block range`);
    }
    const logs: unknown[] = [];
    for (let start = from; start <= to; start += cap) {
      const end = start + cap - 1n < to ? start + cap - 1n : to;
      const part = await endpoint.request({ ...request, params: [{ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }, ...(request.params?.slice(1) ?? [])] });
      if (!Array.isArray(part)) throw new Error("RPC returned an invalid eth_getLogs response");
      logs.push(...part);
    }
    return logs;
  }

  transport(callClass: RpcCallClass): Transport {
    return custom({
      request: ({ method, params }: { method: string; params?: readonly unknown[] }) =>
        this.request(callClass, params === undefined ? { method } : { method, params }),
    }, { retryCount: 0 });
  }

  async request(callClass: RpcCallClass, request: RpcRequest): Promise<unknown> {
    this.resetDailyCountersIfNeeded();
    const lifetime = cacheLifetime(callClass, request);
    const key = cacheKey(request);
    if (lifetime !== undefined) {
      const cached = this.cache.get(key);
      if (cached && (cached.expiresAt === null || cached.expiresAt > this.now())) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        this.recordCacheHit(callClass);
        return cached.value;
      }
      if (cached) this.cache.delete(key);
    }

    const dedupeKey = NO_DEDUPE_METHODS.has(request.method) ? undefined : `${callClass}:${key}`;
    if (dedupeKey) {
      const pending = this.inFlight.get(dedupeKey);
      if (pending) {
        this.recordCacheHit(callClass);
        return pending;
      }
    }

    const work = this.requestWithFailover(callClass, request).then((value) => {
      if (lifetime !== undefined && shouldCacheResponse(request, value)) {
        this.cacheSet(key, {
          value,
          expiresAt: lifetime === null ? null : this.now() + lifetime,
        });
      }
      return value;
    });

    if (!dedupeKey) return work;
    this.inFlight.set(dedupeKey, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(dedupeKey) === work) this.inFlight.delete(dedupeKey);
    }
  }

  /**
   * Send a group of independent JSON-RPC calls together through the same
   * endpoint. The default HTTP transport batches concurrent requests, while
   * this wrapper keeps the group on one route endpoint and accounts for each
   * JSON-RPC method separately.
   */
  async requestBatch(callClass: RpcCallClass, requests: readonly RpcRequest[]): Promise<unknown[]> {
    if (requests.length === 0) return [];

    const route = this.route(callClass);
    const attempted = new Set<string>();
    const candidates = this.candidates(callClass);
    const first = candidates[0];
    // When every endpoint is cooling there is nothing to fail over to: candidates() returns them all and they are
    // tried anyway (the cool-down orders the failover, it must not stop all RPC; with one endpoint it stalled every
    // service for minutes).
    const allCooling = candidates.every((endpoint) => endpoint.coolUntil > this.now());
    let tooWide: LogSpanTooWideError | undefined;

    for (const endpoint of candidates) {
      if (attempted.has(endpoint.id)) continue;
      attempted.add(endpoint.id);
      if (!allCooling && endpoint.coolUntil > this.now()) continue;

      for (const request of requests) this.recordRequest(callClass, endpoint, request.method);
      const startedAt = this.now();
      try {
        // Calling the same endpoint transport concurrently lets viem's HTTP
        // batch scheduler emit one JSON-RPC array while preserving response
        // ordering for callers.
        const results = await Promise.all(requests.map((request) => this.send(endpoint, request)));
        endpoint.failures = 0;
        endpoint.coolUntil = 0;
        this.recordOutcome(endpoint, true, this.now() - startedAt);
        this.noteAnswer(endpoint, first, requests.length);
        return results;
      } catch (error) {
        if (error instanceof LogSpanTooWideError) { tooWide = error; continue; }
        for (const _request of requests) this.recordError(callClass, endpoint);
        if (isExecutionError(error) || !isTransientTransportError(error)) {
          throw safeRpcError(error, this.secrets());
        }
        this.recordOutcome(endpoint, false, this.now() - startedAt);
        this.cool(endpoint);
      }
    }

    if (tooWide) throw safeRpcError(tooWide, this.secrets());
    const last = route.find((endpoint) => attempted.has(endpoint.id));
    throw rpcError(
      last
        ? `All RPC endpoints for ${callClass} are cooling after transient failures (last: ${last.id})`
        : `No RPC endpoints are configured for ${callClass}`,
    );
  }

  private async requestWithFailover(
    callClass: RpcCallClass,
    request: RpcRequest,
  ): Promise<unknown> {
    const route = this.route(callClass);
    const attempted = new Set<string>();
    const candidates = this.candidates(callClass);
    const first = candidates[0];
    // When every endpoint is cooling there is nothing to fail over to: candidates() returns them all and they are
    // tried anyway (the cool-down orders the failover, it must not stop all RPC; with one endpoint it stalled every
    // service for minutes).
    const allCooling = candidates.every((endpoint) => endpoint.coolUntil > this.now());
    let tooWide: LogSpanTooWideError | undefined;

    for (const endpoint of candidates) {
      if (attempted.has(endpoint.id)) continue;
      attempted.add(endpoint.id);
      if (!allCooling && endpoint.coolUntil > this.now()) continue;
      this.recordRequest(callClass, endpoint, request.method);
      const startedAt = this.now();
      try {
        const result = await this.send(endpoint, request);
        endpoint.failures = 0;
        endpoint.coolUntil = 0;
        this.recordOutcome(endpoint, true, this.now() - startedAt);
        this.noteAnswer(endpoint, first, 1);
        return result;
      } catch (error) {
        if (error instanceof LogSpanTooWideError) { tooWide = error; continue; }
        this.recordError(callClass, endpoint);
        if (isExecutionError(error) || !isTransientTransportError(error)) {
          throw safeRpcError(error, this.secrets());
        }
        this.recordOutcome(endpoint, false, this.now() - startedAt);
        this.cool(endpoint);
      }
    }

    if (tooWide) throw safeRpcError(tooWide, this.secrets());
    const last = route.find((endpoint) => attempted.has(endpoint.id));
    throw rpcError(
      last
        ? `All RPC endpoints for ${callClass} are cooling after transient failures (last: ${last.id})`
        : `No RPC endpoints are configured for ${callClass}`,
    );
  }

  private secrets(): string[] {
    return [...this.config.ALCHEMY_API_KEYS, (this.config.RPC_BACKUP_URL ?? "").trim()].filter(Boolean);
  }

  /** The configured route for the class, with the backup endpoint always last. */
  private route(callClass: RpcCallClass): Endpoint[] {
    const backups = this.endpoints.filter((endpoint) => endpoint.kind === "backup");
    return [...this.primaryRoute(callClass), ...backups];
  }

  private primaryRoute(callClass: RpcCallClass): Endpoint[] {
    if (this.endpoints[0]?.kind === "override") return [this.endpoints[0]];

    const routeKinds =
      callClass === "logs"
        ? this.config.RPC_ROUTE_LOGS
        : callClass === "state"
          ? this.config.RPC_ROUTE_STATE
          : this.config.RPC_ROUTE_TX;
    const ordered: Endpoint[] = [];
    const publicEndpoints = this.endpoints.filter((endpoint) => endpoint.kind === "public");
    const alchemyEndpoints = this.endpoints.filter((endpoint) => endpoint.kind === "alchemy");

    for (const kind of routeKinds) {
      if (kind === "public") ordered.push(...publicEndpoints);
      if (kind === "alchemy" && alchemyEndpoints.length > 0) {
        const start = this.alchemyCursor % alchemyEndpoints.length;
        ordered.push(
          ...alchemyEndpoints.slice(start),
          ...alchemyEndpoints.slice(0, start),
        );
      }
    }

    return ordered.length > 0 ? ordered : publicEndpoints;
  }

  private cool(endpoint: Endpoint): void {
    endpoint.failures += 1;
    const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** Math.min(endpoint.failures - 1, 10), MAX_COOLDOWN_MS);
    endpoint.coolUntil = this.now() + backoff;
    if (endpoint.kind === "alchemy") {
      const alchemyEndpoints = this.endpoints.filter((item) => item.kind === "alchemy");
      const index = alchemyEndpoints.findIndex((item) => item.id === endpoint.id);
      if (index >= 0 && alchemyEndpoints.length > 0) {
        this.alchemyCursor = (index + 1) % alchemyEndpoints.length;
      }
    }
  }

  private cacheSet(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private resetDailyCountersIfNeeded(): void {
    const date = utcDateKey(new Date(this.now()));
    if (date === this.metricsDate) return;
    this.metricsDate = date;
    for (const counters of Object.values(this.classCounters)) Object.assign(counters, emptyCounters());
    for (const byClass of this.endpointCounters.values()) {
      for (const counters of Object.values(byClass)) Object.assign(counters, emptyCounters());
    }
  }

  private recordCacheHit(callClass: RpcCallClass): void {
    this.classCounters[callClass].cacheHits += 1;
  }

  private recordRequest(callClass: RpcCallClass, endpoint: Endpoint, method: string): void {
    this.classCounters[callClass].requests += 1;
    this.classCounters[callClass].estimatedCu += methodCu(method);
    const counters = this.endpointCounters.get(endpoint.id)?.[callClass];
    if (counters) {
      counters.requests += 1;
      counters.estimatedCu += methodCu(method);
    }

    if (endpoint.kind === "alchemy") {
      const alchemyEndpoints = this.endpoints.filter((item) => item.kind === "alchemy");
      const index = alchemyEndpoints.findIndex((item) => item.id === endpoint.id);
      if (index >= 0 && alchemyEndpoints.length > 0) {
        this.alchemyCursor = (index + 1) % alchemyEndpoints.length;
      }
    }
  }

  private recordError(callClass: RpcCallClass, endpoint: Endpoint): void {
    this.classCounters[callClass].errors += 1;
    const counters = this.endpointCounters.get(endpoint.id)?.[callClass];
    if (counters) counters.errors += 1;
  }

  stats(): RpcPoolStats {
    this.resetDailyCountersIfNeeded();
    const now = this.now();
    const copyCounters = (counters: Counters): Counters => ({ ...counters });
    return {
      date: this.metricsDate,
      failover: {
        backupConfigured: this.endpoints.some((endpoint) => endpoint.kind === "backup"),
        activeEndpoint: this.activeEndpoint,
        usingBackup: this.activeEndpoint === "backup",
        count: this.failoverCount,
        backupCalls: this.backupCalls,
        lastAt: this.lastFailover ? new Date(this.lastFailover.at).toISOString() : null,
        lastFrom: this.lastFailover?.from ?? null,
        lastTo: this.lastFailover?.to ?? null,
      },
      endpoints: this.endpoints.map((endpoint) => ({
        id: endpoint.id,
        kind: endpoint.kind,
        cooling: endpoint.coolUntil > now,
        coolDownMs: Math.max(0, endpoint.coolUntil - now),
        score: this.score(endpoint),
        successRate: Math.round(endpoint.health.successRate * 1000) / 1000,
        latencyMs: endpoint.health.latencyMs === null ? null : Math.round(endpoint.health.latencyMs),
        lastSuccessAt: endpoint.health.lastSuccessAt === null ? null : new Date(endpoint.health.lastSuccessAt).toISOString(),
        lastFailureAt: endpoint.health.lastFailureAt === null ? null : new Date(endpoint.health.lastFailureAt).toISOString(),
        classes: {
          logs: copyCounters(this.endpointCounters.get(endpoint.id)?.logs ?? emptyCounters()),
          state: copyCounters(this.endpointCounters.get(endpoint.id)?.state ?? emptyCounters()),
          tx: copyCounters(this.endpointCounters.get(endpoint.id)?.tx ?? emptyCounters()),
        },
      })),
      classes: {
        logs: copyCounters(this.classCounters.logs),
        state: copyCounters(this.classCounters.state),
        tx: copyCounters(this.classCounters.tx),
      },
    };
  }

  startHourlyReporter(): void {
    if (this.reportTimer) return;
    let lastHour = new Date(this.now()).toISOString().slice(0, 13);
    this.reportTimer = setInterval(() => {
      const hour = new Date(this.now()).toISOString().slice(0, 13);
      if (hour === lastHour) return;
      lastHour = hour;
      logger.info({ rpcPool: this.stats() }, "Hourly RPC pool summary");
    }, 60_000);
    this.reportTimer.unref?.();
  }
}

export function createRpcPool(config: RuntimeConfig, options?: RpcPoolOptions): RpcPool {
  return new RpcPool(config, options);
}
