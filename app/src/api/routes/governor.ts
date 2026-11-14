import type { OpenAPIHono } from "@hono/zod-openapi";
import { latestLedger, unhedgedSince } from "../../db/queries/governor";
import { latestRiskRun } from "../../db/queries/risk";
import { listGears } from "../../db/queries/gears";
import { readActivePauses, readFreshness } from "../../db/queries/status";
import { wadToUsdg } from "../../lib/fixed";
import { buildGearView } from "../gear-view";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";
import { resolveMarket } from "../resolve";

export const UNHEDGED_SHOW_MS = 15 * 60_000;
export const RISK_RUN_STALE_MS = 36 * 3_600_000;
export const RESERVE_CACHE_MS = 30_000;
const CHAIN_CACHE_MS = 5_000;

const Underlying = z.object({
  underlying: z.string(), delta: z.string(), gamma: z.string(), hedgeDelta: z.string(), residual: z.string(),
  chainDelta: z.string().nullable(), chainGamma: z.string().nullable(), openValue: z.string().nullable(), matchesChain: z.boolean().nullable(),
  unhedgedSince: Iso.nullable(), ledgerAt: Iso,
});
const GovernorSchema = z.object({
  ...MetaFields, live: z.boolean().openapi({ description: "False when the snapshot is older than 30 minutes: numbers are shown for reference, never as live." }),
  equityWad: z.string(), freeCashUsdg: z.string(), stressLoss: z.object({ lossWad: z.string(), budgetWad: z.string() }),
  hedgeStale: z.boolean(), buysPaused: z.boolean(), buysPausedReason: z.string().nullable(),
  hedgeEquity: z.object({ offChain: z.literal(true), usdg: z.string().nullable() }),
  exitReserve: z.object({ balanceUsdg: z.string(), floorUsdg: z.string(), chainReadAt: Iso }),
  underlyings: z.array(Underlying),
  capsUsed: z.array(z.object({ symbol: z.string(), capUsdg: z.string(), openUsdg: z.string() })),
  lastRiskRun: z.object({ at: Iso.nullable(), ageSec: z.number().nullable(), stale: z.boolean(), summary: z.record(z.string(), z.unknown()) }).nullable(),
  pauses: z.array(z.object({ scope: z.string(), ref: z.string().nullable(), since: Iso, reason: z.string().nullable() })),
}).openapi("Governor");

/** |a - b| within one USDG unit (a, b in raw USDG). */
export const withinOneUnit = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) <= 1n;

export function registerGovernorRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/governor", summary: "The Governor: equity, exposure per underlying, hedge residual, exit reserve, stress", tag: "governor", response: GovernorSchema, cache: "public, max-age=5", errors: [502] }, async () => {
    const now = nowOf(deps);
    const gov = deps.chain.governor;
    const cached = <T>(key: string, ttl: number, load: () => Promise<T>) => deps.cache.getOrLoad(`gov:${key}`, ttl, load);
    const [fresh, ledger, pauses, risk, gears] = await Promise.all([readFreshness(deps.sql, now), latestLedger(deps.sql), readActivePauses(deps.sql), latestRiskRun(deps.sql), listGears(deps.sql)]);
    const [equity, freeCash, stress, hedgeStale, paused, balance, floor] = await Promise.all([
      cached("equity", CHAIN_CACHE_MS, () => gov.equity()), cached("cash", CHAIN_CACHE_MS, () => gov.freeCash()), cached("stress", CHAIN_CACHE_MS, () => gov.stressLoss()),
      cached("hedgeStale", CHAIN_CACHE_MS, () => gov.hedgeStale()), cached("paused", CHAIN_CACHE_MS, () => gov.buysPaused()),
      cached("reserve", RESERVE_CACHE_MS, () => gov.exitReserve()), cached("floor", RESERVE_CACHE_MS, () => gov.exitReserveFloor()),
    ]);
    const underlyings = await Promise.all(ledger.map(async (row) => {
      const market = resolveMarket(deps.deployment, row.underlying);
      const exposure = market ? await cached(`exposure:${market.id}`, CHAIN_CACHE_MS, () => gov.exposure(market.id)) : null;
      const delta = BigInt(row.delta);
      const gamma = BigInt(row.gamma);
      const chainDelta = exposure ? wadToUsdg(exposure.deltaUsdWad) : null;
      const chainGamma = exposure ? wadToUsdg(exposure.gammaUsdWad) : null;
      const residual = delta - BigInt(row.hedgeDelta);
      const since = residual === 0n ? null : await unhedgedSince(deps.sql, row.underlying);
      const showSince = since !== null && now.getTime() - since.getTime() > UNHEDGED_SHOW_MS;
      return {
        underlying: row.underlying, delta: delta.toString(), gamma: gamma.toString(), hedgeDelta: row.hedgeDelta, residual: residual.toString(),
        chainDelta: chainDelta?.toString() ?? null, chainGamma: chainGamma?.toString() ?? null, openValue: exposure ? wadToUsdg(exposure.openValueWad).toString() : null,
        matchesChain: chainDelta === null || chainGamma === null ? null : withinOneUnit(delta, chainDelta) && withinOneUnit(gamma, chainGamma),
        unhedgedSince: showSince ? since!.toISOString() : null, ledgerAt: row.ts.toISOString(),
      };
    }));
    const views = gears.map((g) => buildGearView(g, deps.deployment, pauses, now));
    const riskAt = risk?.ts ?? null;
    const riskAge = riskAt ? Math.floor((now.getTime() - riskAt.getTime()) / 1000) : null;
    return {
      ...metaOf(fresh), live: !fresh.stale,
      equityWad: equity.toString(), freeCashUsdg: freeCash.toString(), stressLoss: { lossWad: stress.lossWad.toString(), budgetWad: stress.budgetWad.toString() },
      hedgeStale, buysPaused: paused.paused, buysPausedReason: paused.paused ? paused.reason : null,
      hedgeEquity: { offChain: true as const, usdg: null },
      exitReserve: { balanceUsdg: balance.toString(), floorUsdg: floor.toString(), chainReadAt: now.toISOString() },
      underlyings, capsUsed: views.map((g) => ({ symbol: g.symbol, capUsdg: g.cap, openUsdg: g.openValue })),
      lastRiskRun: risk ? { at: riskAt?.toISOString() ?? null, ageSec: riskAge, stale: riskAge === null || riskAge * 1000 > RISK_RUN_STALE_MS, summary: risk.meta } : null,
      pauses: pauses.map((p) => ({ scope: p.scope, ref: p.ref, since: p.ts, reason: p.reason })),
    };
  });
}
