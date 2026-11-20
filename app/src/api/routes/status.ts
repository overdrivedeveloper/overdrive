import type { OpenAPIHono } from "@hono/zod-openapi";
import { readActivePauses, readFreshness, readServices } from "../../db/queries/status";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const Status = z.object({
  ...MetaFields,
  indexer: z.object({ lagBlocks: z.string().nullable(), lastOk: Iso.nullable(), lastError: z.string().nullable(), snapshotStale: z.boolean() }),
  /** mode: "dry_run" or "live" for a job that reports a dry-run flag (the hedger), null for every other job. The site says hedging is active only on "live". */
  services: z.array(z.object({ job: z.string(), lastRun: Iso.nullable(), lastOk: Iso.nullable(), lastError: z.string().nullable(), mode: z.enum(["dry_run", "live"]).nullable() })),
  /** Per market, whether the guard reads a reference price (fresh Pyth or a TWAP pool). Written by the crank's pyth-push job; null until it has run. */
  oracle: z.object({
    checkedAt: Iso.nullable(), ok: z.boolean(),
    markets: z.array(z.object({ symbol: z.string(), ok: z.boolean(), source: z.enum(["pyth", "twap", "none"]), pythAgeSeconds: z.number().nullable(), refMaxAge: z.number().nullable(), reason: z.string().nullable() })),
  }).nullable(),
  pauses: z.array(z.object({ scope: z.string(), ref: z.string().nullable(), since: Iso, reason: z.string().nullable(), pausedBy: z.string().nullable(), whoCanUnpause: z.string() })),
}).openapi("Status");

/** The guardian pauses; only the timelock unpauses, after its delay (48 h). Said on every pause. */
export const WHO_CAN_UNPAUSE = "The timelock, after its 48 hour delay (the guardian can only pause).";

export function registerStatusRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/status", summary: "Indexer lag, service heartbeats and pauses", tag: "system", response: Status, cache: "public, max-age=5", errors: [] }, async () => {
    const fresh = await readFreshness(deps.sql, nowOf(deps));
    const [services, pauses] = await Promise.all([readServices(deps.sql), readActivePauses(deps.sql)]);
    return {
      ...metaOf(fresh),
      indexer: { lagBlocks: fresh.lagBlocks, lastOk: fresh.lastOk, lastError: fresh.lastError, snapshotStale: fresh.snapshotStale },
      services: services.map((s) => ({ job: s.job, lastRun: s.lastRun, lastOk: s.lastOk, lastError: s.lastError, mode: modeOf(s.meta) })),
      oracle: oracleOf(services.find((s) => s.job === "pyth-push")?.meta.reference),
      pauses: pauses.map((p) => ({ scope: p.scope, ref: p.ref, since: p.ts, reason: p.reason, pausedBy: p.actor, whoCanUnpause: WHO_CAN_UNPAUSE })),
    };
  });
}

/** A job's run mode from its stored meta.dryRun: true is "dry_run", false is "live", absent or malformed is null. */
export function modeOf(meta: Record<string, unknown> | null | undefined): "dry_run" | "live" | null {
  const v = meta?.dryRun;
  return v === true ? "dry_run" : v === false ? "live" : null;
}

interface StoredReference { checkedAt?: unknown; ok?: unknown; markets?: unknown }
/** The crank's last reference check as stored in service_status.meta.reference; anything malformed reads as "not checked". */
export function oracleOf(raw: unknown): z.infer<typeof Status>["oracle"] {
  const ref = raw as StoredReference | undefined;
  if (!ref || !Array.isArray(ref.markets)) return null;
  const markets = (ref.markets as Record<string, unknown>[]).map((m) => ({
    symbol: String(m.symbol), ok: m.ok === true,
    source: (m.source === "pyth" || m.source === "twap" ? m.source : "none") as "pyth" | "twap" | "none",
    pythAgeSeconds: typeof m.pythAgeSeconds === "number" ? m.pythAgeSeconds : null,
    refMaxAge: typeof m.refMaxAge === "number" ? m.refMaxAge : null,
    reason: typeof m.reason === "string" ? m.reason : null,
  }));
  return { checkedAt: typeof ref.checkedAt === "string" ? ref.checkedAt : null, ok: markets.length > 0 && markets.every((m) => m.ok), markets };
}
