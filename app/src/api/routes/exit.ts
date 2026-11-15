import type { OpenAPIHono } from "@hono/zod-openapi";
import { latestReserve, queueStats } from "../../db/queries/exit";
import { listGears } from "../../db/queries/gears";
import { readActivePauses, readFreshness } from "../../db/queries/status";
import { buildGearView, type GearView } from "../gear-view";
import { RESERVE_CACHE_MS } from "./governor";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const ExitSchema = z.object({
  ...MetaFields, live: z.boolean(), reserveUsdg: z.string(), floorUsdg: z.string(), ringFenced: z.boolean(), aboveFloor: z.boolean(),
  coverageRatioBps: z.number().nullable().openapi({ description: "Exit reserve over the open value of all gears, in basis points." }),
  queue: z.object({ depth: z.number(), oldestAt: Iso.nullable(), oldestAgeSec: z.number().nullable() }),
  gears: z.array(z.object({ symbol: z.string(), canExitNow: z.boolean(), sellMode: z.enum(["instant", "instant_min"]), rule: z.string() })),
}).openapi("Exit");

/** R10. A gear can be exited now only when the reserve is above its floor and the gear is sellable by the closed-market rule. */
export function canExitNow(aboveFloor: boolean, g: Pick<GearView, "status" | "session" | "price">): boolean {
  if (!aboveFloor || g.status === "retired") return false;
  if (g.session === "OPEN" || g.session === "EXTENDED") return true;
  return g.price !== null; // closed: pays the lower of the last value and a fresh Pyth value, else queues (the quote route reads the minter for which)
}
export const ruleWords = (sellMode: "instant" | "instant_min"): string =>
  sellMode === "instant" ? "The market is open: a sell pays the current value less the spread." : "The market is closed: a sell pays the lower of the last value and the reference value when the reference is a fresh Pyth price, and otherwise waits in the queue for the next live price.";

export function registerExitRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/exit", summary: "Exit reserve, floor, coverage and queue", tag: "governor", response: ExitSchema, cache: "public, max-age=5", errors: [502] }, async () => {
    const now = nowOf(deps);
    const [fresh, log, queue, pauses, rows] = await Promise.all([readFreshness(deps.sql, now), latestReserve(deps.sql), queueStats(deps.sql), readActivePauses(deps.sql), listGears(deps.sql)]);
    const [balance, floor] = await Promise.all([
      deps.cache.getOrLoad("gov:reserve", RESERVE_CACHE_MS, () => deps.chain.governor.exitReserve()), deps.cache.getOrLoad("gov:floor", RESERVE_CACHE_MS, () => deps.chain.governor.exitReserveFloor()),
    ]);
    const views = rows.map((r) => buildGearView(r, deps.deployment, pauses, now));
    const open = views.reduce((sum, g) => sum + BigInt(g.openValue), 0n);
    const aboveFloor = balance > floor;
    const oldest = queue.oldest;
    return {
      ...metaOf(fresh), live: !fresh.stale, reserveUsdg: balance.toString(), floorUsdg: floor.toString(), ringFenced: log?.ringFenced ?? true, aboveFloor,
      coverageRatioBps: open === 0n ? null : Number((balance * 10_000n) / open),
      queue: { depth: Number(queue.depth), oldestAt: oldest?.toISOString() ?? null, oldestAgeSec: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : null },
      gears: views.map((g) => ({ symbol: g.symbol, canExitNow: canExitNow(aboveFloor, g), sellMode: g.sellMode, rule: ruleWords(g.sellMode) })),
    };
  });
}
