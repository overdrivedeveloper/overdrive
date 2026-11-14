// Hedger persistence: fills (unique client id), one row per name per cycle, open/cleared signals, service_status meta.
import type { Sql } from "postgres";
import type { SignalKind } from "../../hedger/types";
import { toBigInt } from "../../lib/fixed";

export interface HedgeRow {
  ts: Date; venue: string; underlying: string; usd: bigint; px: bigint; feesUsd: bigint; ref: string | null; reason: string; dry: boolean; clientId: string;
}
export interface CycleRow {
  ts: Date; underlying: string; deltaUsd: bigint; gammaUsd: bigint; positionUsd: bigint; residualUsd: bigint; bandUsd: bigint;
  action: "traded" | "would_trade" | "hold" | "failed"; reason: string; inputAgeS: number | null;
}

/** What the hedge cycle needs from storage; the SQL version is below, tests use an in-memory one. */
export interface HedgerStore {
  /** false when that client id is already recorded (the fill is never counted twice). */
  recordHedge(row: HedgeRow): Promise<boolean>;
  hedgeByClientId(clientId: string): Promise<HedgeRow | null>;
  recordCycle(row: CycleRow): Promise<void>;
  /** Opens a signal unless one of that kind is already open for the name. */
  raiseSignal(kind: SignalKind, underlying: string, detail: Record<string, unknown>): Promise<void>;
  clearSignal(kind: SignalKind, underlying: string): Promise<void>;
  writeStatus(job: string, ok: boolean, meta: Record<string, unknown>, error?: string): Promise<void>;
}

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export function createSqlHedgerStore(sql: Sql): HedgerStore {
  return {
    async recordHedge(r) {
      const rows = await sql`
        INSERT INTO hedges (ts, venue, underlying, side, usd, px, fees_usd, ref, reason, dry, client_id)
        VALUES (${r.ts.toISOString()}::timestamptz, ${r.venue}, ${r.underlying}, ${r.usd >= 0n ? "buy" : "sell"}, ${r.usd.toString()}, ${r.px.toString()}, ${r.feesUsd.toString()},
                ${r.ref}, ${r.reason}, ${r.dry}, ${r.clientId})
        ON CONFLICT (client_id) DO NOTHING RETURNING id`;
      return rows.length === 1;
    },
    async hedgeByClientId(clientId) {
      const rows = await sql<{ ts: Date; venue: string; underlying: string; usd: string; px: string; fees_usd: string; ref: string | null; reason: string; dry: boolean; client_id: string }[]>`
        SELECT ts, venue, underlying, usd, px, fees_usd, ref, reason, dry, client_id FROM hedges WHERE client_id = ${clientId}`;
      const r = rows[0];
      return r ? { ts: new Date(r.ts), venue: r.venue, underlying: r.underlying, usd: toBigInt(r.usd), px: toBigInt(r.px), feesUsd: toBigInt(r.fees_usd), ref: r.ref, reason: r.reason, dry: r.dry, clientId: r.client_id } : null;
    },
    async recordCycle(r) {
      await sql`
        INSERT INTO hedge_cycles (ts, underlying, delta_usd, gamma_usd, position_usd, residual_usd, band_usd, action, reason, input_age_s)
        VALUES (${r.ts.toISOString()}::timestamptz, ${r.underlying}, ${r.deltaUsd.toString()}, ${r.gammaUsd.toString()}, ${r.positionUsd.toString()}, ${r.residualUsd.toString()},
                ${r.bandUsd.toString()}, ${r.action}, ${r.reason}, ${r.inputAgeS})`;
    },
    async raiseSignal(kind, underlying, detail) {
      await sql`
        INSERT INTO hedger_signals (kind, underlying, detail) VALUES (${kind}, ${underlying}, ${json(detail)}::jsonb)
        ON CONFLICT (kind, underlying) WHERE cleared_at IS NULL DO UPDATE SET detail = EXCLUDED.detail`;
    },
    async clearSignal(kind, underlying) {
      await sql`UPDATE hedger_signals SET cleared_at = now() WHERE kind = ${kind} AND underlying = ${underlying} AND cleared_at IS NULL`;
    },
    async writeStatus(job, ok, meta, error) {
      await sql`
        INSERT INTO service_status (job, last_run, last_ok, last_error, meta)
        VALUES (${job}, now(), CASE WHEN ${ok} THEN now() END, ${error ?? null}, ${json(meta)}::jsonb)
        ON CONFLICT (job) DO UPDATE SET last_run = now(), last_ok = COALESCE(EXCLUDED.last_ok, service_status.last_ok),
          last_error = EXCLUDED.last_error, meta = service_status.meta || EXCLUDED.meta`;
    },
  };
}

/** Net filled notional per name and venue (live fills only), for reconciliation against venue positions. */
export async function hedgeFillTotals(sql: Sql): Promise<{ underlying: string; venue: string; usd: bigint }[]> {
  const rows = await sql<{ underlying: string; venue: string; usd: string }[]>`
    SELECT underlying, venue, SUM(usd)::numeric(78,0)::text AS usd FROM hedges WHERE NOT dry GROUP BY underlying, venue ORDER BY underlying, venue`;
  return rows.map((r) => ({ underlying: r.underlying, venue: r.venue, usd: toBigInt(r.usd) }));
}

/** In-memory store for unit tests and the fuzz. */
export function createMemoryHedgerStore() {
  const hedges: HedgeRow[] = [];
  const cycles: CycleRow[] = [];
  const signals: { kind: SignalKind; underlying: string; detail: Record<string, unknown>; open: boolean }[] = [];
  const status = new Map<string, { ok: boolean; meta: Record<string, unknown>; error?: string | undefined }>();
  const store: HedgerStore = {
    async recordHedge(r) { if (hedges.some((h) => h.clientId === r.clientId)) return false; hedges.push(r); return true; },
    async hedgeByClientId(id) { return hedges.find((h) => h.clientId === id) ?? null; },
    async recordCycle(r) { cycles.push(r); },
    async raiseSignal(kind, underlying, detail) {
      const open = signals.find((s) => s.kind === kind && s.underlying === underlying && s.open);
      if (open) open.detail = detail; else signals.push({ kind, underlying, detail, open: true });
    },
    async clearSignal(kind, underlying) { for (const s of signals) if (s.kind === kind && s.underlying === underlying) s.open = false; },
    async writeStatus(job, ok, meta, error) { status.set(job, { ok, meta: { ...(status.get(job)?.meta ?? {}), ...meta }, error }); },
  };
  return { store, hedges, cycles, signals, status };
}

// Read side for the public API (/v1/hedges): Governor ledger hedge deltas and the hedger's last status meta.
export const recentHedges = (sql: Sql, limit: number) => sql<{ ts: Date; underlying: string; delta: string; hedgeDelta: string; block: string }[]>`
  SELECT ts, underlying, delta::text AS delta, hedge_delta::text AS "hedgeDelta", block::text AS block FROM governor_ledger
  WHERE hedge_delta <> 0 ORDER BY ts DESC LIMIT ${limit}`;
export const hedgeFills = (sql: Sql, limit: number) => sql<{ ts: Date; meta: Record<string, unknown> }[]>`
  SELECT COALESCE(last_ok, last_run) AS ts, meta FROM service_status WHERE job = 'hedger' LIMIT 1`.then((rows) => rows.slice(0, limit));
