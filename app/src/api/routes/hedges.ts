import type { OpenAPIHono } from "@hono/zod-openapi";
import { recentHedges } from "../../db/queries/hedges";
import { readFreshness } from "../../db/queries/status";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const HedgesSchema = z.object({ ...MetaFields, hedges: z.array(z.object({ ts: Iso, underlying: z.string(), delta: z.string(), hedgeDelta: z.string(), block: z.string() })) }).openapi("Hedges");

export function registerHedgeRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/hedges", summary: "Recent hedge positions from the Governor ledger", tag: "governor", response: HedgesSchema, cache: "public, max-age=30", errors: [] }, async () => {
    const now = nowOf(deps);
    const [fresh, rows] = await Promise.all([readFreshness(deps.sql, now), recentHedges(deps.sql, 100)]);
    return { ...metaOf(fresh), hedges: rows.map((r) => ({ ...r, ts: r.ts.toISOString() })) };
  });
}
