import type { OpenAPIHono } from "@hono/zod-openapi";
import { defineRoute } from "../route-kit";
import { AddressSchema, Hex32, z } from "../schemas";
import type { ApiDependencies } from "../types";

const Config = z.object({
  chainId: z.number(), network: z.string(), commit: z.string(), startBlock: z.number(),
  admin: z.object({ ownerSafe: AddressSchema, timelock: AddressSchema, guardianSafe: AddressSchema, minDelaySec: z.number() }),
  external: z.record(z.string(), AddressSchema),
  contracts: z.record(z.string(), z.string()),
  markets: z.array(z.object({ id: Hex32, symbol: z.string(), kind: z.string(), alwaysOpen: z.boolean() })),
  gears: z.array(z.object({ id: Hex32, symbol: z.string(), gear: z.string(), power: z.string(), marketA: z.string(), marketB: z.string().nullable(), token: AddressSchema, poolId: Hex32, capUsd: z.string(), spreadBps: z.number() })),
}).openapi("Config");

/** Every address comes from the deployment file, the one source (R12). */
export function registerConfigRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/config", summary: "Addresses and gears from the deployment file", tag: "system", response: Config, cache: "public, max-age=60", errors: [] }, async () => {
    const d = deps.deployment;
    return {
      chainId: d.chainId, network: d.network, commit: d.commit, startBlock: d.startBlock, admin: d.admin, external: d.external, contracts: d.contracts,
      markets: d.markets.map((m) => ({ id: m.id, symbol: m.symbol, kind: m.kind, alwaysOpen: m.alwaysOpen })),
      gears: d.gears.map((g) => ({ id: g.id, symbol: g.symbol, gear: g.gear, power: g.power, marketA: g.marketA, marketB: g.marketB, token: g.token, poolId: g.poolId, capUsd: g.capUsd, spreadBps: g.spreadBps })),
    };
  });
}
