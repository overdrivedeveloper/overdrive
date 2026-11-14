import type { OpenAPIHono } from "@hono/zod-openapi";
import { ledgerSince } from "../../db/queries/governor";
import { readFreshness } from "../../db/queries/status";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, RANGES, RangeQuery, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const History = z.object({ ...MetaFields, range: z.string(), rows: z.array(z.object({ ts: Iso, underlying: z.string(), delta: z.string(), gamma: z.string(), hedgeDelta: z.string(), equity: z.string(), exitReserve: z.string(), block: z.string() })) }).openapi("GovernorHistory");

export function registerGovernorHistoryRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/governor/history", summary: "Rows of the Governor ledger", tag: "governor", query: RangeQuery, response: History, cache: "public, max-age=30", errors: [400] }, async (_c, { query }) => {
    const now = nowOf(deps);
    const since = new Date(now.getTime() - RANGES[query.range as keyof typeof RANGES]);
    const [rows, fresh] = await Promise.all([ledgerSince(deps.sql, since, 5000), readFreshness(deps.sql, now)]);
    return { ...metaOf(fresh), range: query.range as string, rows: rows.map((r) => ({ ...r, ts: r.ts.toISOString() })) };
  });
}
