import type { OpenAPIHono } from "@hono/zod-openapi";
import { getGear, listGears } from "../../db/queries/gears";
import { readActivePauses, readFreshness } from "../../db/queries/status";
import { buildGearView } from "../gear-view";
import { resolveGear } from "../resolve";
import { defineRoute } from "../route-kit";
import { Hex32, MetaFields, metaOf, notFound, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

export const GearSchema = z.object({
  symbol: z.string(), id: Hex32, underlying: z.string(), underlyingB: z.string().nullable(), power: z.string(), token: z.string(), gear: z.string().nullable(),
  price: z.string().nullable().openapi({ description: "Underlying price, WAD (last indexed)." }), valuePerToken: z.string(), valueSource: z.enum(["trade", "trade_nf", "listing"]).openapi({ description: "How valuePerToken is derived. trade_nf: the last trade value moved to the current NF (toll since the trade included; the underlying price is not re-applied). trade: the last trade value as is (no NF history). listing: unit value times NF." }), nf: z.string(),
  tollPerDayBps: z.string().openapi({ description: "Daily toll in basis points; negative means holders receive." }), tollPer30DaysBps: z.string(), holdersReceive: z.boolean(), tollFormulaBps: z.string().nullable(),
  sigmaBps: z.string().nullable(), sigmaAgeSec: z.number().nullable(), sigmaWarning: z.enum(["floor"]).nullable(),
  spreadBps: z.number(), cap: z.string(), openValue: z.string(), status: z.string(), session: z.string(),
  buyable: z.boolean(), reason: z.string().nullable(), sellMode: z.enum(["instant", "instant_min"]), pausedBy: z.string().nullable(),
}).openapi("Gear");

const GearList = z.object({ ...MetaFields, gears: z.array(GearSchema) }).openapi("GearList");
const GearOne = z.object({ ...MetaFields, gear: GearSchema }).openapi("GearOne");

export function registerGearRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/gears", summary: "All gears with price, daily toll, spread, cap and sell mode", tag: "gears", response: GearList, cache: "public, max-age=5", errors: [] }, async () => {
    const now = nowOf(deps);
    const [rows, pauses, fresh] = await Promise.all([listGears(deps.sql), readActivePauses(deps.sql), readFreshness(deps.sql, now)]);
    return { ...metaOf(fresh), gears: rows.map((r) => buildGearView(r, deps.deployment, pauses, now)) };
  });
  defineRoute(app, { method: "get", path: "/v1/gears/{id}", summary: "One gear by symbol or id", tag: "gears", params: z.object({ id: z.string().min(1).max(80) }), response: GearOne, cache: "public, max-age=5", errors: [400, 404] }, async (context, { params }) => {
    const ref = resolveGear(deps.deployment, params.id);
    if (!ref) return notFound(context, "Unknown gear.");
    const now = nowOf(deps);
    const [row, pauses, fresh] = await Promise.all([getGear(deps.sql, ref.id), readActivePauses(deps.sql), readFreshness(deps.sql, now)]);
    if (!row) return notFound(context, "Gear not indexed yet.");
    return { ...metaOf(fresh), gear: buildGearView(row, deps.deployment, pauses, now) };
  });
}
