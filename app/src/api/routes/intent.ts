import type { OpenAPIHono } from "@hono/zod-openapi";
import { encodeFunctionData } from "viem";
import { IODMinterAbi } from "../../abi";
import { ApiError } from "../errors";
import { minOutSuggested } from "../quote/model";
import type { QuoteService } from "../quote/quoter";
import { resolveGear } from "../resolve";
import { defineRoute } from "../route-kit";
import { AddressSchema, Hex32, MetaFields, notFound, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";

const IntentBody = z.object({
  gear: z.string().min(1).max(80), account: AddressSchema,
  usdg: z.string().regex(/^\d{1,40}$/).optional(), tokens: z.string().regex(/^\d{1,40}$/).optional(),
  minOut: z.string().regex(/^\d{1,40}$/).optional().openapi({ description: "Smallest output you accept. Default: the quote less 50 bps." }),
  recipient: AddressSchema.optional(), deadlineSec: z.number().int().min(30).max(3600).default(300),
});
const Intent = z.object({
  ...MetaFields, kind: z.enum(["buy", "sell", "queue_sell"]), quoteId: z.string(), blockNumber: z.string(),
  tx: z.object({ to: AddressSchema, data: z.string(), value: z.literal("0") }),
  approvals: z.array(z.object({ token: AddressSchema, spender: AddressSchema, amount: z.string() })),
  permit2: z.null().openapi({ description: "Permit2 payload; null while Permit2 is not enabled for this deployment." }),
  expectedOut: z.string(), minOut: z.string(), note: z.string(),
}).openapi("Intent");

/** Unsigned transaction intents built from a fresh quote. Never signs, never sends. */
export function registerIntentRoutes(app: OpenAPIHono, deps: ApiDependencies, service: QuoteService): void {
  const build = (side: "buy" | "sell") => async (context: any, { body }: { body: z.infer<typeof IntentBody> }) => {
    const ref = resolveGear(deps.deployment, body.gear);
    if (!ref) return notFound(context, "Unknown gear.");
    const raw = side === "buy" ? body.usdg : body.tokens;
    if (!raw || BigInt(raw) <= 0n) throw new ApiError(400, "BAD_REQUEST", side === "buy" ? "A buy needs usdg." : "A sell needs tokens.");
    const amount = BigInt(raw);
    const o = await service.quote({ gear: ref.id, side, exactIn: amount, account: body.account });
    const minter = deps.deployment.contracts.ODMinter as `0x${string}`;
    const recipient = (body.recipient ?? body.account) as `0x${string}`;
    // The contract checks the deadline against block.timestamp: count from the later of the wall clock and the chain's clock,
    // so a chain ahead of the wall (a warped fork) does not get an intent that is already expired.
    const wallSec = BigInt(Math.floor(nowOf(deps).getTime() / 1000));
    const chainSec = deps.chain.blockTimestamp ? await deps.chain.blockTimestamp().catch(() => 0n) : 0n;
    const deadline = (chainSec > wallSec ? chainSec : wallSec) + BigInt(body.deadlineSec);
    const base = { asOfBlock: o.blockNumber.toString(), asOf: new Date(o.asOfMs).toISOString(), stale: false, decimals: { usdg: 6 as const, token: 18 as const, value: 18 as const }, quoteId: o.quoteId, blockNumber: o.blockNumber.toString(), permit2: null };
    if (o.sellMode === "queued" && o.minter) {
      const minOut = BigInt(body.minOut ?? minOutSuggested(o.minter.amountOut).toString());
      return { ...base, kind: "queue_sell" as const, tx: { to: minter, data: encodeFunctionData({ abi: IODMinterAbi, functionName: "queueSell", args: [ref.id as `0x${string}`, amount, minOut, recipient] }), value: "0" as const }, approvals: [{ token: ref.token as `0x${string}`, spender: minter, amount: amount.toString() }], expectedOut: o.minter.amountOut.toString(), minOut: minOut.toString(), note: "Queued: paid at the next fresh price, never below your minimum." };
    }
    if (!o.buyable || !o.v4) throw new ApiError(409, (o.refusal?.code === "QUEUED" || !o.refusal ? "UPSTREAM" : o.refusal.code), "This trade cannot execute now.", o.refusal?.reason);
    const out = o.v4.amountOut;
    const minOut = BigInt(body.minOut ?? o.minOutSuggested!.toString());
    if (minOut > out) throw new ApiError(400, "BAD_REQUEST", "minOut is above the quoted output.");
    const data = side === "buy"
      ? encodeFunctionData({ abi: IODMinterAbi, functionName: "buy", args: [ref.id as `0x${string}`, amount, minOut, recipient, deadline] })
      : encodeFunctionData({ abi: IODMinterAbi, functionName: "sell", args: [ref.id as `0x${string}`, amount, minOut, recipient, deadline] });
    const token = side === "buy" ? (deps.deployment.external.usdg as `0x${string}`) : (ref.token as `0x${string}`);
    return { ...base, kind: side, tx: { to: minter, data, value: "0" as const }, approvals: [{ token, spender: minter, amount: amount.toString() }], expectedOut: out.toString(), minOut: minOut.toString(), note: "Unsigned. Sign it with your own wallet; the API holds no key." };
  };
  for (const side of ["buy", "sell"] as const) {
    defineRoute(app, { method: "post", path: `/v1/intent/${side}`, summary: `Unsigned ${side} transaction from a fresh quote`, tag: "quotes", auth: "public_rate_limited", body: IntentBody, response: Intent, errors: [400, 404, 409, 502] }, build(side));
  }
}
