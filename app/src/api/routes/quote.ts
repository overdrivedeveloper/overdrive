import type { OpenAPIHono } from "@hono/zod-openapi";
import { createQuoteService, type QuoteOutcome, type QuoteService } from "../quote/quoter";
import { breakevenDays, tollBpsText, type RawQuote } from "../quote/model";
import { resolveGear } from "../resolve";
import { defineRoute } from "../route-kit";
import { AddressSchema, Hex32, Iso, MetaFields, bad, notFound, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

export const QUOTE_TTL_MS = 30_000;
const MAX_AMOUNT = 2n ** 120n;

const RawQuoteSchema = z.object({
  amountIn: z.string(), amountOut: z.string(), valuePerTokenWad: z.string().nullable(), pricePerTokenWad: z.string().nullable(), spreadBps: z.number().nullable(),
  protocolFeeUsdg: z.string().nullable(), tollPerDayWad: z.string().nullable(), session: z.number().nullable(), queued: z.boolean(),
});
export const QuoteSchema = z.object({
  ...MetaFields,
  gear: z.string(), gearId: Hex32, side: z.enum(["buy", "sell"]), source: z.literal("v4_quoter"), blockNumber: z.string(), quoteId: z.string(), expiresAt: Iso,
  buyable: z.boolean().openapi({ description: "True only when the same trade executes now with these amounts. A sell that can only be queued is false with sellMode queued." }),
  reason: z.string().nullable(), code: z.string().nullable(), message: z.string().nullable(),
  sellMode: z.enum(["instant", "instant_min", "queued"]).nullable(), priceRule: z.string().nullable(),
  amountIn: z.string().nullable(), amountOut: z.string().nullable(), tokensOut: z.string().nullable(), usdgOut: z.string().nullable(),
  valuePerToken: z.string().nullable(), spreadBps: z.number().nullable(), tollPerDayBps: z.string().nullable(), holdersReceive: z.boolean(), breakevenDays: z.number().nullable(),
  minOutSuggested: z.string().nullable(), minterQuote: RawQuoteSchema.nullable(), parity: z.array(z.string()),
  queue: z.object({ rule: z.string(), minUsdgOutSuggested: z.string() }).nullable(),
}).openapi("Quote");

const QuoteQuery = z.object({
  gear: z.string().min(1).max(80), side: z.enum(["buy", "sell"]),
  usdg: z.string().regex(/^\d{1,40}$/).optional().openapi({ description: "Buy: USDG in, raw 6 dp integer." }),
  tokens: z.string().regex(/^\d{1,40}$/).optional().openapi({ description: "Sell: gear tokens in, raw 18 dp integer." }),
  account: AddressSchema.optional(),
});

const text = (v: bigint | null) => (v === null ? null : v.toString());
const rawOut = (q: RawQuote | null) => q && ({
  amountIn: q.amountIn.toString(), amountOut: q.amountOut.toString(), valuePerTokenWad: text(q.valuePerTokenWad), pricePerTokenWad: text(q.pricePerTokenWad),
  spreadBps: q.spreadBps, protocolFeeUsdg: text(q.protocolFeeUsdg), tollPerDayWad: text(q.tollPerDayWad), session: q.session, queued: q.queued,
});
const MESSAGES: Record<string, string> = {
  CLOSED: "The market is closed: buys are not available.", STALE: "The price is not fresh enough: buys are not available.", PAUSED: "Buys are paused for this gear.",
  CAP_REACHED: "This gear is at its cap for this size.", BELOW_MIN: "This is below the minimum trade.", RESERVE_FLOOR: "The exit reserve is at its floor: new buys wait.",
  UPSTREAM: "This quote cannot be confirmed right now.", QUEUED: "A sell now is queued and paid at the next fresh price.",
};

export function quoteDocument(deps: Pick<ApiDependencies, "deployment">, ref: { id: string; symbol: string }, o: QuoteOutcome) {
  const q = o.v4 ?? null;
  const m = o.minter;
  const toll = m?.tollPerDayWad ?? null;
  const spread = m?.spreadBps ?? null;
  const priced = q !== null;
  const closedSell = o.side === "sell" && o.sellMode === "instant_min";
  return {
    asOfBlock: o.blockNumber.toString(), asOf: new Date(o.asOfMs).toISOString(), stale: false, decimals: { usdg: 6 as const, token: 18 as const, value: 18 as const },
    gear: ref.symbol, gearId: ref.id, side: o.side, source: "v4_quoter" as const, blockNumber: o.blockNumber.toString(), quoteId: o.quoteId, expiresAt: new Date(o.asOfMs + QUOTE_TTL_MS).toISOString(),
    buyable: o.buyable, reason: o.refusal?.reason ?? null, code: o.refusal?.code ?? null, message: o.refusal ? MESSAGES[o.refusal.code] ?? null : null,
    sellMode: o.sellMode, priceRule: closedSell ? "The market is closed: a sell pays the lower of the last value and the reference value." : o.sellMode === "queued" ? "Paid at the next fresh price, never below your minimum." : null,
    amountIn: priced ? q.amountIn.toString() : null, amountOut: priced ? q.amountOut.toString() : o.sellMode === "queued" && m ? m.amountOut.toString() : null,
    tokensOut: priced && o.side === "buy" ? q.amountOut.toString() : null, usdgOut: priced && o.side === "sell" ? q.amountOut.toString() : null,
    valuePerToken: text(m?.valuePerTokenWad ?? null), spreadBps: spread, tollPerDayBps: toll === null ? null : tollBpsText(toll), holdersReceive: toll !== null && toll < 0n,
    breakevenDays: spread !== null && toll !== null ? breakevenDays(spread, toll) : null,
    minOutSuggested: text(o.minOutSuggested), minterQuote: rawOut(m), parity: o.parity,
    queue: o.sellMode === "queued" && m ? { rule: "Paid at the next fresh price, never below your minimum.", minUsdgOutSuggested: (o.minOutSuggested ?? 0n).toString() } : null,
  };
}

export function quoteServiceOf(deps: ApiDependencies): QuoteService {
  return createQuoteService({ chain: deps.chain, cache: deps.cache, maxRpc: deps.config.API_QUOTE_MAX_RPC_PER_REQUEST, cacheMs: deps.config.API_QUOTE_CACHE_MS, now: () => nowOf(deps).getTime() });
}

export function registerQuoteRoutes(app: OpenAPIHono, deps: ApiDependencies, service: QuoteService): void {
  defineRoute(app, { method: "get", path: "/v1/quote", summary: "Exact quote: what executes is what is quoted", description: "Asks V4Quoter through the hook (the executable path) and IODMinter.quote at the same block; the two must agree field by field.", tag: "quotes", auth: "public_rate_limited", query: QuoteQuery, response: QuoteSchema, errors: [400, 404, 502] }, async (context, { query }) => {
    const ref = resolveGear(deps.deployment, query.gear);
    if (!ref) return notFound(context, "Unknown gear.");
    const side = query.side as "buy" | "sell";
    const raw = side === "buy" ? query.usdg : query.tokens;
    if (query.usdg !== undefined && query.tokens !== undefined) return bad(context, "Give usdg (buy) or tokens (sell), not both.");
    if (raw === undefined) return bad(context, side === "buy" ? "A buy needs usdg." : "A sell needs tokens.");
    const amount = BigInt(raw);
    if (amount <= 0n || amount >= MAX_AMOUNT) return bad(context, "The amount is out of range.");
    const outcome = await service.quote({ gear: ref.id, side, exactIn: amount, account: query.account });
    context.header("Cache-Control", "no-store");
    return quoteDocument(deps, ref, outcome);
  });
}
