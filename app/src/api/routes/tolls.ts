import type { OpenAPIHono } from "@hono/zod-openapi";
import { listGears } from "../../db/queries/gears";
import { readActivePauses, readFreshness } from "../../db/queries/status";
import { buildGearView } from "../gear-view";
import { FORMULA_MD, formulaConstants } from "../formula";
import { defineRoute } from "../route-kit";
import { MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const TollRow = z.object({
  symbol: z.string(), power: z.string(), tollPerDayBps: z.string(), tollPer30DaysBps: z.string(), holdersReceive: z.boolean(),
  tollFormulaBps: z.string().nullable().openapi({ description: "The published formula evaluated at the latest posted sigma." }),
  sigmaBps: z.string().nullable(), sigmaAgeSec: z.number().nullable(), sigmaWarning: z.enum(["floor"]).nullable(),
});
const Tolls = z.object({ ...MetaFields, tolls: z.array(TollRow) }).openapi("Tolls");
const Formula = z.object({ formula: z.string(), constants: z.record(z.string(), z.string()), document: z.string() }).openapi("TollFormula");

export function registerTollRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/tolls", summary: "The daily toll of every gear, now", tag: "gears", response: Tolls, cache: "public, max-age=5", errors: [] }, async () => {
    const now = nowOf(deps);
    const [rows, pauses, fresh] = await Promise.all([listGears(deps.sql), readActivePauses(deps.sql), readFreshness(deps.sql, now)]);
    const tolls = rows.map((r) => buildGearView(r, deps.deployment, pauses, now)).map((g) => ({
      symbol: g.symbol, power: g.power, tollPerDayBps: g.tollPerDayBps, tollPer30DaysBps: g.tollPer30DaysBps, holdersReceive: g.holdersReceive,
      tollFormulaBps: g.tollFormulaBps, sigmaBps: g.sigmaBps, sigmaAgeSec: g.sigmaAgeSec, sigmaWarning: g.sigmaWarning,
    }));
    return { ...metaOf(fresh), tolls };
  });
  defineRoute(app, { method: "get", path: "/v1/tolls/formula", summary: "The published toll formula and its constants", tag: "gears", response: Formula, cache: "public, max-age=3600", errors: [] }, async () => ({
    formula: "toll per day = 1/2 x p x (p - 1) x sigma^2 / 365 + usage. Eco (p = 0.5) is negative: holders receive.",
    constants: formulaConstants(), document: FORMULA_MD,
  }));
}
