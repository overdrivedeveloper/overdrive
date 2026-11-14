import type { OpenAPIHono } from "@hono/zod-openapi";
import { vaultById, vaultsOf, type VaultRow } from "../../db/queries/backers";
import { listGears } from "../../db/queries/gears";
import { readFreshness } from "../../db/queries/status";
import { WAD } from "../../lib/fixed";
import { defineRoute } from "../route-kit";
import { AddressSchema, MetaFields, metaOf, notFound, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";
import { symbolOf } from "../gear-view";

/** Backer health in bps: collateral value over debt value. The liquidator (todo 17) must use this same function; the
 * contract getter `ODBacker.health` is the authority and the route reports the getter's ratio. */
export function healthBps(collateralUsdg: bigint, debtValueWad: bigint): bigint {
  if (debtValueWad === 0n) return 0n;
  return (collateralUsdg * 10n ** 12n * 10_000n) / debtValueWad;
}
/** The price at which the ratio equals maintenance: value moves as price^p, so P* = P x (ratio / maintenance)^(1/p). */
export function liquidationPriceWad(priceWad: bigint, ratioBps: bigint, maintenanceBps: bigint, power: number): bigint | null {
  if (priceWad === 0n || ratioBps === 0n || maintenanceBps === 0n || power === 0) return null;
  const factor = Math.pow(Number(ratioBps) / Number(maintenanceBps), 1 / power);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return (priceWad * BigInt(Math.round(factor * 1e12))) / 10n ** 12n;
}

const VaultSchema = z.object({
  id: z.string(), owner: AddressSchema, gear: z.string(), gearId: z.string(), status: z.string(), collateralUsdg: z.string(), debtTokens: z.string(), debtValueWad: z.string(),
  healthRatioBps: z.string(), computedRatioBps: z.string(), requiredBps: z.string(), maintenanceBps: z.string(), belowMaintenance: z.boolean(),
  weekendUplift: z.object({ active: z.boolean(), upliftBps: z.number() }), liquidationPrice: z.string().nullable(),
}).openapi("Vault");
const Backer = z.object({ ...MetaFields, vaults: z.array(VaultSchema) }).openapi("Backer");
const VaultOne = z.object({ ...MetaFields, vault: VaultSchema }).openapi("VaultOne");

/** The market whose weekend uplift applies to a gear. The indexed gear row carries the on-chain market id (market_a), which is
 * authoritative: resolving it through the deployment file's market list silently reported "no uplift" for any gear whose market
 * the file does not list (BUG-3), so the file is only a fallback. */
export function underlyingMarketOf(deps: ApiDependencies, g: { marketA: string; underlying: string }): string | undefined {
  if (/^0x[0-9a-fA-F]{64}$/.test(g.marketA)) return g.marketA;
  return deps.deployment.markets.find((m) => m.symbol === g.underlying)?.id;
}

export function registerBackerRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  const ttl = 10_000;
  async function view(row: VaultRow, prices: Map<string, { price: bigint; power: number; underlyingMarket: string | undefined }>) {
    const h = await deps.cache.getOrLoad(`vault:${row.id}`, ttl, () => deps.chain.backerHealth(BigInt(row.id)));
    const info = prices.get(row.gear.toLowerCase());
    const uplift = info?.underlyingMarket ? await deps.cache.getOrLoad(`uplift:${info.underlyingMarket}`, ttl, () => deps.chain.upliftActive(info.underlyingMarket!)) : { active: false, upliftBps: 0 };
    return {
      id: row.id, owner: row.owner as `0x${string}`, gear: symbolOf(deps.deployment, row.gear), gearId: row.gear, status: row.status, collateralUsdg: h.collateralUsdg.toString(), debtTokens: row.debtTokens,
      debtValueWad: h.debtValueWad.toString(), healthRatioBps: h.ratioBps.toString(), computedRatioBps: healthBps(h.collateralUsdg, h.debtValueWad).toString(), requiredBps: h.requiredBps.toString(),
      maintenanceBps: h.maintenanceBps.toString(), belowMaintenance: h.debtValueWad > 0n && h.ratioBps < h.maintenanceBps, weekendUplift: uplift,
      liquidationPrice: info && h.debtValueWad > 0n ? liquidationPriceWad(info.price, h.ratioBps, h.maintenanceBps, info.power)?.toString() ?? null : null,
    };
  }
  async function priceMap() {
    const gears = await listGears(deps.sql);
    return new Map(gears.map((g) => [g.id.toLowerCase(), { price: g.priceWad ? BigInt(g.priceWad) : 0n, power: Number(g.power), underlyingMarket: underlyingMarketOf(deps, g) }]));
  }
  defineRoute(app, { method: "get", path: "/v1/backers/{address}", summary: "A backer's vaults with health against maintenance", tag: "accounts", params: z.object({ address: AddressSchema }), response: Backer, cache: "public, max-age=5", errors: [400, 502] }, async (_c, { params }) => {
    const now = nowOf(deps);
    const [rows, fresh, prices] = await Promise.all([vaultsOf(deps.sql, params.address), readFreshness(deps.sql, now), priceMap()]);
    return { ...metaOf(fresh), vaults: await Promise.all(rows.map((r) => view(r, prices))) };
  });
  defineRoute(app, { method: "get", path: "/v1/vaults/{id}", summary: "One vault", tag: "accounts", params: z.object({ id: z.string().regex(/^\d{1,30}$/) }), response: VaultOne, cache: "public, max-age=5", errors: [400, 404, 502] }, async (context, { params }) => {
    const now = nowOf(deps);
    const [row, fresh, prices] = await Promise.all([vaultById(deps.sql, params.id), readFreshness(deps.sql, now), priceMap()]);
    if (!row) return notFound(context, "Unknown vault.");
    return { ...metaOf(fresh), vault: await view(row, prices) };
  });
}
export const WAD_CONST = WAD;
