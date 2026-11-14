import type { Context } from "hono";
import type { Sql } from "postgres";
import type { ApiDependencies } from "./types";

/**
 * Account routes that read many series per call (TU09 position history, TU24 statement). Security review M1: they must
 * never be able to take the whole database pool. Each route gets its own small semaphore (default 2 at once; a request
 * waits at most `waitMs` for a slot, then answers 503) and every query runs in a read-only transaction with
 * `SET LOCAL statement_timeout`, so one heavy account answers 503 instead of holding a connection for minutes.
 */
export class HeavyReadBusy extends Error {
  constructor() { super("Too many heavy account reads right now."); }
}

export interface HeavyReadOptions { concurrency?: number; timeoutMs?: number; waitMs?: number }

export function createHeavyReads(deps: Pick<ApiDependencies, "sql">, options: HeavyReadOptions = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 3_000));
  const waitMs = Math.max(0, options.waitMs ?? 5_000);
  let active = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < concurrency) { active++; return; }
    await new Promise<void>((resolve, reject) => {
      const wake = () => { clearTimeout(timer); active++; resolve(); };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(wake);
        if (index >= 0) waiting.splice(index, 1);
        reject(new HeavyReadBusy());
      }, waitMs);
      waiting.push(wake);
    });
  }
  function release(): void {
    active--;
    waiting.shift()?.();
  }

  return {
    get active(): number { return active; },
    /** Runs `fn` with a transaction-bound `sql` under the route's slot and statement timeout. */
    async run<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await deps.sql.begin("read only", async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
          return fn(tx as unknown as Sql);
        }) as T;
      } finally {
        release();
      }
    },
  };
}

/** A heavy read that was refused (no slot) or cut off by the statement timeout: answer 503, never 500. */
export function heavyReadFailure(context: Context, error: unknown): Response | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof HeavyReadBusy || code === "57014") {
    context.header("Retry-After", "5");
    return context.json({ error: "BUSY", message: "This account is busy to read right now. Try again in a moment." }, 503);
  }
  return undefined;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** The zero address and the deployment's own contracts are party to every mint, burn or escrow: they have no account
 * history of their own, and reading theirs would select every series. */
export function protocolAddresses(deployment: unknown): Set<string> {
  const out = new Set<string>([ZERO]);
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === "string") { if (/^0x[0-9a-fA-F]{40}$/.test(value)) out.add(value.toLowerCase()); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
  };
  walk((deployment as { contracts?: unknown } | null)?.contracts, 0);
  return out;
}

export function protocolAddressAnswer(context: Context) {
  return context.json({ error: "BAD_REQUEST", message: "That is the zero address or a protocol contract, not an account." }, 400);
}
