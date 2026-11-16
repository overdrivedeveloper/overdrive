import type { OpenAPIHono } from "@hono/zod-openapi";
import { missingForNext, PERKS, thresholdsOf, TIER_PERKS, tierOf, type Tier } from "../../lib/holder-tiers";
import { ApiError } from "../errors";
import { defineRoute } from "../route-kit";
import { AddressSchema, z } from "../schemas";
import type { ApiDependencies } from "../types";

const NOTE = "Perks unlock from a wallet's $OVRD balance, read on chain. $OVRD is a utility token with no cash value; nothing here is a promise of any amount or of any price effect. Core features (trading, deposits, withdrawals, the exit page, safety pages) are never gated.";
const HolderSchema = z.object({
  account: AddressSchema, status: z.enum(["not_live", "live"]), tier: z.enum(["none", "holder", "whale"]).nullable(), perks: z.array(z.enum(PERKS)),
  thresholds: z.object({ holderMin: z.string(), whaleMin: z.string() }), balance: z.string().nullable(), missingForNext: z.object({ next: z.enum(["holder", "whale"]), missingTokens: z.string() }).nullable(),
  stakeFeeDiscountBps: z.number().nullable(), message: z.string(), note: z.string(),
}).openapi("Holder");

export function registerHolderRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  const th = thresholdsOf(deps.config);
  const thresholds = { holderMin: th.holderMin.toString(), whaleMin: th.whaleMin.toString() };
  const fmt = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  defineRoute(app, { method: "get", path: "/v1/holder/{address}", summary: "Holder tier and perks from the wallet's $OVRD balance (read only)", tag: "accounts", params: z.object({ address: AddressSchema }), response: HolderSchema, cache: "public, max-age=15", errors: [400, 502] }, async (_c, { params }) => {
    const account = (params.address as string).toLowerCase() as `0x${string}`;
    const token = deps.config.OVRD_TOKEN_ADDRESS;
    // Before the token exists: no RPC call, no invented tier.
    if (token === "") {
      return { account, status: "not_live" as const, tier: null, perks: [], thresholds, balance: null, missingForNext: null, stakeFeeDiscountBps: null, message: `Unlocks for $OVRD holders (${fmt(th.holderMin)}+)`, note: NOTE };
    }
    // Fail closed: a failed read throws (502) and grants nothing.
    if (!deps.chain.tokenBalance) throw new ApiError(502, "UPSTREAM", "Balance read is unavailable.");
    const read = await deps.cache.getOrLoad(`holder:${account}`, 15_000, () => deps.chain.tokenBalance!(token, account)).catch(() => { throw new ApiError(502, "UPSTREAM", "Balance read failed; no perks are granted."); });
    const tier: Tier = tierOf(read.balance, read.decimals, th);
    const discount = deps.chain.stakeAccount ? await deps.chain.stakeAccount(account).then((s) => s.feeDiscountBps, () => null) : null;
    const next = missingForNext(read.balance, read.decimals, th);
    return {
      account, status: "live" as const, tier, perks: [...TIER_PERKS[tier]], thresholds, balance: read.balance.toString(), missingForNext: next, stakeFeeDiscountBps: discount,
      message: tier === "none" ? `Hold ${fmt(th.holderMin)} $OVRD to unlock Holder perks` : tier === "holder" ? `Hold ${fmt(th.whaleMin)} $OVRD to unlock Whale perks` : "All perks unlocked", note: NOTE,
    };
  });
}
