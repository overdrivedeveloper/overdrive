import type { OpenAPIHono } from "@hono/zod-openapi";
import { latestRiskRun } from "../../db/queries/risk";
import { readFreshness } from "../../db/queries/status";
import { RISK_RUN_STALE_MS } from "./governor";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const RiskSchema = z.object({ ...MetaFields, run: z.object({ at: Iso.nullable(), ageSec: z.number().nullable(), stale: z.boolean(), summary: z.record(z.string(), z.unknown()) }).nullable() }).openapi("Risk");

export function registerRiskRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/risk", summary: "Latest risk-sim run and cap plan, with its age", tag: "governor", response: RiskSchema, cache: "public, max-age=60", errors: [] }, async () => {
    const now = nowOf(deps);
    const [fresh, run] = await Promise.all([readFreshness(deps.sql, now), latestRiskRun(deps.sql)]);
    const age = run?.ts ? Math.floor((now.getTime() - run.ts.getTime()) / 1000) : null;
    return { ...metaOf(fresh), run: run ? { at: run.ts?.toISOString() ?? null, ageSec: age, stale: age === null || age * 1000 > RISK_RUN_STALE_MS, summary: run.meta } : null };
  });
}
