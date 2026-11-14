import type { OpenAPIHono } from "@hono/zod-openapi";
import { feeTotals } from "../../db/queries/fees";
import { readFreshness } from "../../db/queries/status";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const FeesSchema = z.object({
  ...MetaFields, protocolSpreadShareBps: z.number(), tollFeeBps: z.number(), distributableUsdg: z.string(), nextDistributionAt: Iso.nullable(),
  totals: z.array(z.object({ kind: z.string(), totalUsdg: z.string(), lastAt: Iso.nullable() })),
}).openapi("Fees");

export function registerFeeRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/fees", summary: "Fee splits as read from chain and fee totals", tag: "governor", response: FeesSchema, cache: "public, max-age=30", errors: [502] }, async () => {
    const now = nowOf(deps);
    const [fresh, totals, splits] = await Promise.all([readFreshness(deps.sql, now), feeTotals(deps.sql), deps.cache.getOrLoad("fees:splits", 30_000, () => deps.chain.feeSplits())]);
    const next = Number(splits.nextDistributionAt);
    return {
      ...metaOf(fresh), protocolSpreadShareBps: splits.protocolSpreadShareBps, tollFeeBps: splits.tollFeeBps, distributableUsdg: splits.distributable.toString(),
      nextDistributionAt: next > 0 ? new Date(next * 1000).toISOString() : null, totals: totals.map((t) => ({ kind: t.kind, totalUsdg: t.total, lastAt: t.last?.toISOString() ?? null })),
    };
  });
}
