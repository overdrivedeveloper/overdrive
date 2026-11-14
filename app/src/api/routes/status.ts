import type { OpenAPIHono } from "@hono/zod-openapi";
import { readActivePauses, readFreshness, readServices } from "../../db/queries/status";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const Status = z.object({
  ...MetaFields,
  indexer: z.object({ lagBlocks: z.string().nullable(), lastOk: Iso.nullable(), lastError: z.string().nullable(), snapshotStale: z.boolean() }),
  services: z.array(z.object({ job: z.string(), lastRun: Iso.nullable(), lastOk: Iso.nullable(), lastError: z.string().nullable() })),
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
      services: services.map((s) => ({ job: s.job, lastRun: s.lastRun, lastOk: s.lastOk, lastError: s.lastError })),
      pauses: pauses.map((p) => ({ scope: p.scope, ref: p.ref, since: p.ts, reason: p.reason, pausedBy: p.actor, whoCanUnpause: WHO_CAN_UNPAUSE })),
    };
  });
}
