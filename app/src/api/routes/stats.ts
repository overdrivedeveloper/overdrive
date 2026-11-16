import type { OpenAPIHono } from "@hono/zod-openapi";
import { realUsers } from "../../db/queries/users";
import { readFreshness } from "../../db/queries/status";
import { defineRoute } from "../route-kit";
import { Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

export const REAL_USER_DEFINITION = "Distinct wallets that made at least one buy or sell, or opened at least one backer vault, as indexed from chain. Team, bot and Safe addresses from config, the deployment's own Safes, timelock and contracts, and the zero address never count. Token holders are not users; a wallet that only holds or transfers counts for nothing.";

/** Addresses that never count: config lists plus the deployment's own contracts and admin Safes. Lowercase, deduplicated. */
export function excludedAddresses(deps: ApiDependencies): string[] {
  const c = deps.config;
  const d = deps.deployment;
  const own = ([...Object.values(d.contracts ?? {}), d.admin?.ownerSafe, d.admin?.timelock, d.admin?.guardianSafe] as unknown[]).filter((x): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x));
  return [...new Set([...c.USER_COUNT_EXCLUDE_TEAM, ...c.USER_COUNT_EXCLUDE_BOTS, ...c.USER_COUNT_EXCLUDE_SAFES, ...own].map((a) => a.toLowerCase()))];
}

const UsersSchema = z.object({
  ...MetaFields, realUsers: z.number(), traders: z.number(), backers: z.number(), both: z.number(), firstActivityAt: Iso.nullable(), definition: z.string(), excludedAddresses: z.number(),
}).openapi("RealUsers");

export function registerStatsRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/stats/users", summary: "Real-user count: distinct wallets that bought, sold or backed", tag: "system", response: UsersSchema, cache: "public, max-age=60", errors: [502] }, async () => {
    const excluded = excludedAddresses(deps);
    const [fresh, u] = await Promise.all([readFreshness(deps.sql, nowOf(deps)), realUsers(deps.sql, excluded)]);
    return { ...metaOf(fresh), realUsers: u.total, traders: u.traders, backers: u.backers, both: u.both, firstActivityAt: u.firstAt?.toISOString() ?? null, definition: REAL_USER_DEFINITION, excludedAddresses: excluded.length };
  });
}
