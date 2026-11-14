import type { OpenAPIHono } from "@hono/zod-openapi";
import { firstTradeAt, holdings, tollPerTokenSince } from "../../db/queries/account";
import { queuedForAccount } from "../../db/queries/exit";
import { listGears } from "../../db/queries/gears";
import { readActivePauses, readFreshness } from "../../db/queries/status";
import { WAD, wadToUsdg } from "../../lib/fixed";
import { buildGearView } from "../gear-view";
import { defineRoute } from "../route-kit";
import { AddressSchema, Iso, MetaFields, metaOf, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const AccountSchema = z.object({
  ...MetaFields, account: AddressSchema,
  balances: z.array(z.object({
    gear: z.string(), token: z.string(), balance: z.string(), valueUsdg: z.string(), costBasisUsdg: z.string().nullable(), tollPaidUsdg: z.string(), sellMode: z.enum(["instant", "instant_min"]),
  })),
  queuedSells: z.array(z.object({ ticket: z.string(), gear: z.string(), tokens: z.string(), minProceedsUsdg: z.string(), queuedAt: Iso })),
}).openapi("Account");

export function registerAccountRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  defineRoute(app, { method: "get", path: "/v1/account/{address}", summary: "Balances per gear with value, cost basis from trades, toll paid and queued sells", tag: "accounts", params: z.object({ address: AddressSchema }), response: AccountSchema, cache: "public, max-age=5", errors: [400] }, async (_c, { params }) => {
    const account = (params.address as string).toLowerCase();
    const now = nowOf(deps);
    const [held, queued, gears, pauses, fresh] = await Promise.all([holdings(deps.sql, account), queuedForAccount(deps.sql, account), listGears(deps.sql), readActivePauses(deps.sql), readFreshness(deps.sql, now)]);
    const views = new Map(gears.map((g) => [g.id, buildGearView(g, deps.deployment, pauses, now)]));
    const balances = await Promise.all(held.map(async (h) => {
      const v = views.get(h.gear)!;
      const balance = BigInt(h.balance);
      const bought = BigInt(h.bought);
      // Cost basis: average buy cost of the tokens still held (null when the tokens did not come from a buy).
      const cost = bought > 0n ? (BigInt(h.boughtUsdg) * balance) / bought : null;
      const toll = (await tollPerTokenSince(deps.sql, h.gear, await firstTradeAt(deps.sql, h.gear, account))) * balance / WAD;
      return { gear: v.symbol, token: h.token, balance: h.balance, valueUsdg: wadToUsdg((balance * BigInt(v.valuePerToken)) / WAD).toString(), costBasisUsdg: cost === null ? null : cost.toString(), tollPaidUsdg: wadToUsdg(toll).toString(), sellMode: v.sellMode };
    }));
    return {
      ...metaOf(fresh), account: params.address as `0x${string}`, balances,
      queuedSells: queued.map((q) => ({ ticket: q.ticket, gear: views.get(q.gear)?.symbol ?? q.gear, tokens: q.tokens, minProceedsUsdg: q.minProceeds, queuedAt: q.queuedAt.toISOString() })),
    };
  });
}
