import type { Context, MiddlewareHandler } from "hono";
import type { Sql } from "postgres";
import { rateLimit } from "./rate-limit";
import { createHeavyReads, heavyReadFailure } from "./heavy-read";
import type { ApiDependencies } from "./types";

/**
 * Shared guard rails of the public insight routes (agent activity, option history, stats, holding-cost history,
 * depositor view, open interest):
 *  - a per-client limiter (IPv4 address or IPv6 /64, the R3-07 shape) on top of the global one;
 *  - every query in a read-only transaction with a statement timeout, at most `concurrency` at once per route group
 *    (security review M1 pattern, heavy-read.ts): a slow read answers 503 BUSY, never 500, and never holds the pool.
 */
export function publicReadLimiter(deps: Pick<ApiDependencies, "config">, perMinute: number): MiddlewareHandler {
  return rateLimit({
    limit: deps.config.API_RATE_LIMIT_PER_MINUTE === 0 ? 0 : perMinute,
    windowMs: 60_000,
    clientIpHeader: deps.config.API_CLIENT_IP_HEADER,
  });
}

export interface PublicReads {
  run<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  readonly active: number;
}

export function publicReads(deps: Pick<ApiDependencies, "sql">, options: { concurrency?: number; timeoutMs?: number } = {}): PublicReads {
  return createHeavyReads(deps, { concurrency: options.concurrency ?? 3, timeoutMs: options.timeoutMs ?? 3_000, waitMs: 5_000 });
}

/** A refused or timed-out read: 503 with Retry-After. Anything else is rethrown to the API's error handler. */
export function busyOr(context: Context, error: unknown): Response {
  const answer = heavyReadFailure(context, error);
  if (answer) return answer;
  throw error;
}

/** Keyset cursor (ts, tx hash, log index), opaque to clients. */
export interface TimeCursor { ts: string; txHash: string; logIndex: number }

export const encodeTimeCursor = (cursor: TimeCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export function decodeTimeCursor(value: string): TimeCursor | null {
  if (value.length > 400) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TimeCursor>;
    if (typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) return null;
    if (typeof parsed.txHash !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(parsed.txHash)) return null;
    if (!Number.isInteger(parsed.logIndex) || (parsed.logIndex as number) < 0) return null;
    return { ts: new Date(parsed.ts).toISOString(), txHash: parsed.txHash.toLowerCase(), logIndex: parsed.logIndex as number };
  } catch {
    return null;
  }
}
