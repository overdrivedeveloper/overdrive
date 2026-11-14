import type { OpenAPIHono } from "@hono/zod-openapi";
import { gearHistory } from "../../db/queries/gears";
import { getGear } from "../../db/queries/gears";
import { readFreshness } from "../../db/queries/status";
import { resolveGear } from "../resolve";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, RANGES, RangeQuery, metaOf, notFound, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const History = z.object({
  ...MetaFields, symbol: z.string(), range: z.string(),
  points: z.array(z.object({ ts: Iso, nf: z.string(), tollPerSecWad: z.string(), valuePerTokenWad: z.string().nullable(), priceWad: z.string().nullable() })),
}).openapi("GearHistory");

/** NF, value per token and toll series from nf_history and prices. Postgres only. */
export function registerGearHistoryRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/gears/{id}/history", summary: "NF, value per token and toll series", tag: "gears", params: z.object({ id: z.string().min(1).max(80) }), query: RangeQuery, response: History, cache: "public, max-age=30", errors: [400, 404] }, async (context, { params, query }) => {
    const ref = resolveGear(deps.deployment, params.id);
    if (!ref) return notFound(context, "Unknown gear.");
    const now = nowOf(deps);
    const row = await getGear(deps.sql, ref.id);
    if (!row) return notFound(context, "Gear not indexed yet.");
    const since = new Date(now.getTime() - RANGES[query.range as keyof typeof RANGES]);
    const [points, fresh] = await Promise.all([gearHistory(deps.sql, ref.id, row.underlying, since, 2000), readFreshness(deps.sql, now)]);
    return { ...metaOf(fresh), symbol: ref.symbol, range: query.range as string, points };
  });
}
