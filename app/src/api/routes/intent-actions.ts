// Unsigned transaction intents for the actions beyond buy and sell: backer vaults, queued sells, agent policy.
// Same rules as routes/intent.ts: reads only, never signs or sends, 409 with the reason code when it cannot run now.
// The pre-flight checks mirror ODBacker (the contract stays the authority; a pre-flight is never a promise).
import type { OpenAPIHono } from "@hono/zod-openapi";
import { encodeFunctionData } from "viem";
import { IODAgentRouterAbi, IODBackerAbi, IODMinterAbi } from "../../abi";
import { ZERO_ADDRESS } from "../chain-reads";
import { ApiError } from "../errors";
import { minOutSuggested, type ErrorCode } from "../quote/model";
import type { QuoteService } from "../quote/quoter";
import { resolveGear, resolveMarket } from "../resolve";
import { defineRoute } from "../route-kit";
import { AddressSchema, MetaFields, notFound, z } from "../schemas";
import { nowOf, type ApiDependencies } from "../types";
import { healthBps } from "./backers";

const MIN_COLLATERAL_USDG = 50_000_000n; // ODBacker.MIN_COLLATERAL_USDG
const UINT128_MAX = (1n << 128n) - 1n;
const Uint = z.string().regex(/^\d{1,40}$/);
const Id = z.string().regex(/^\d{1,30}$/);
const Bool = z.boolean();

const KINDS = ["back_open", "back_deposit", "back_mint", "back_repay", "back_repay_usdg", "back_withdraw", "queue_cancel", "queue_fill", "agent_policy", "agent_revoke"] as const;
const ActionIntent = z.object({
  ...MetaFields, kind: z.enum(KINDS), chainId: z.number(), blockNumber: z.string(),
  tx: z.object({ to: AddressSchema, data: z.string(), value: z.literal("0") }),
  approvals: z.array(z.object({ token: AddressSchema, spender: AddressSchema, amount: z.string() })),
  permit2: z.null().openapi({ description: "Permit2 payload; null while Permit2 is not enabled for this deployment." }),
  preflight: z.record(z.string(), z.string()).openapi({ description: "The numbers the checks used (raw integer strings). Informational: the contract decides." }),
  note: z.string(),
}).openapi("ActionIntent");

const OpenBody = z.object({ gear: z.string().min(1).max(80), account: AddressSchema, collateralUsdg: Uint, owner: AddressSchema.optional().openapi({ description: "Open the vault for another owner (openVaultFor). Default: account." }) });
const DepositBody = z.object({ account: AddressSchema, vaultId: Id, usdg: Uint });
const MintBody = z.object({
  account: AddressSchema, vaultId: Id, tokens: Uint,
  sellToGovernor: Bool.default(true).openapi({ description: "Sell the minted tokens to the Governor; the proceeds join the collateral. An operator always sells." }),
  minProceedsUsdg: Uint.optional().openapi({ description: "Smallest proceeds you accept. Default: the estimate less 50 bps." }),
});
const RepayBody = z.object({ account: AddressSchema, vaultId: Id, tokens: Uint });
const RepayUsdgBody = z.object({ account: AddressSchema, vaultId: Id, tokens: Uint, maxCostUsdg: Uint.optional().openapi({ description: "Most collateral you accept paying. Default: the estimate plus 50 bps." }) });
const WithdrawBody = z.object({ account: AddressSchema, vaultId: Id, usdg: Uint, to: AddressSchema.optional() });
const CancelBody = z.object({ account: AddressSchema, ticket: Id });
const FillBody = z.object({ ticket: Id, account: AddressSchema.optional() });
const PolicyBody = z.object({
  account: AddressSchema.openapi({ description: "The owner granting the policy." }), agent: AddressSchema,
  budgetUsdg: Uint, maxPerTradeUsdg: Uint, expiresAt: z.number().int().positive().openapi({ description: "Unix seconds; must be in the future." }),
  canSell: Bool.default(false), canBack: Bool.default(false),
  markets: z.array(z.string().min(1).max(80)).min(1).max(32).openapi({ description: "Markets the agent may trade, by symbol (TSLA) or bytes32 id." }),
});
const RevokeBody = z.object({ account: AddressSchema, agent: AddressSchema });

const positive = (raw: string, what: string): bigint => { const v = BigInt(raw); if (v <= 0n) throw new ApiError(400, "BAD_REQUEST", `${what} must be above zero.`); return v; };
const lower = (a: string) => a.toLowerCase();

export function registerIntentActionRoutes(app: OpenAPIHono, deps: ApiDependencies, service: QuoteService): void {
  const addressOf = (name: "ODBacker" | "ODMinter" | "ODAgentRouter"): `0x${string}` => {
    const a = deps.deployment.contracts[name];
    if (!a) throw new ApiError(409, "PAUSED", `${name} is not deployed on this network.`, "NOT_DEPLOYED");
    return a as `0x${string}`;
  };
  const usdg = () => deps.deployment.external.usdg as `0x${string}`;

  /** Wraps one action: block number, meta, chain id, the unsigned tx. */
  async function done(kind: (typeof KINDS)[number], to: `0x${string}`, data: `0x${string}`, approvals: Array<{ token: `0x${string}`; spender: `0x${string}`; amount: bigint }>, preflight: Record<string, bigint | string>, note: string, block?: bigint) {
    const blockNumber = block ?? (await deps.chain.blockNumber());
    return {
      asOfBlock: blockNumber.toString(), asOf: nowOf(deps).toISOString(), stale: false, decimals: { usdg: 6 as const, token: 18 as const, value: 18 as const },
      kind, chainId: Number(deps.config.CHAIN_ID), blockNumber: blockNumber.toString(), tx: { to, data, value: "0" as const },
      approvals: approvals.map((a) => ({ token: a.token, spender: a.spender, amount: a.amount.toString() })), permit2: null,
      preflight: Object.fromEntries(Object.entries(preflight).map(([k, v]) => [k, v.toString()])), note,
    };
  }

  async function vaultOf(context: any, raw: string) {
    const v = await deps.chain.backerVault(BigInt(raw));
    if (lower(v.owner) === ZERO_ADDRESS) return { response: notFound(context, "Unknown vault.") };
    return { vault: v, id: BigInt(raw) };
  }
  const requireOwner = (owner: string, account: string) => {
    if (lower(owner) !== lower(account)) throw new ApiError(400, "BAD_REQUEST", "Only the vault owner can do this.", "NOT_VAULT_OWNER");
  };
  /** Same rule as ODBacker._liveBatch: a batch id is live until its window expires. */
  async function refuseInBatch(batchId: bigint) {
    if (batchId === 0n) return;
    const w = await deps.chain.backerBatchWindow(batchId);
    if (w.expiresAt !== 0n && BigInt(Math.floor(nowOf(deps).getTime() / 1000)) < w.expiresAt) throw new ApiError(409, "PAUSED", "This vault is in a liquidation batch.", "IN_BATCH");
  }
  /** The gear's reading, through the same quote path the buy intent uses. A refusal that means "no live reading" is thrown. */
  async function reading(gearId: string, refuseCodes: readonly ErrorCode[]) {
    const o = await service.quote({ gear: gearId, side: "buy", exactIn: 100_000_000n });
    const r = o.refusal;
    if (r && (refuseCodes as readonly string[]).includes(r.code)) throw new ApiError(409, r.code as ErrorCode, "The reading is not live, so this cannot run now.", r.reason);
    return { block: o.blockNumber, value: o.minter?.valuePerTokenWad ?? null, spreadBps: BigInt(o.minter?.spreadBps ?? 0) };
  }
  /** Value of `tokens` in WAD at a per-token WAD value. */
  const valueWad = (tokens: bigint, perToken: bigint) => (tokens * perToken) / 10n ** 18n;

  // ------------------------------------------------------------------------------------------ backer vaults
  defineRoute(app, { method: "post", path: "/v1/intent/back/open", summary: "Unsigned openVault (or openVaultFor) transaction", tag: "quotes", auth: "public_rate_limited", body: OpenBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof OpenBody> }) => {
    const ref = resolveGear(deps.deployment, body.gear);
    if (!ref) return notFound(context, "Unknown gear.");
    const backer = addressOf("ODBacker");
    const collateral = positive(body.collateralUsdg, "collateralUsdg");
    if (ref.gear === "ECO") throw new ApiError(400, "BAD_REQUEST", "ECO gears cannot be backed.", "NOT_BACKABLE");
    if (collateral < MIN_COLLATERAL_USDG) throw new ApiError(409, "BELOW_MIN", "A vault needs at least 50 USDG.", "MIN_COLLATERAL");
    const owner = (body.owner ?? body.account) as `0x${string}`;
    const forOther = lower(owner) !== lower(body.account);
    const data = forOther
      ? encodeFunctionData({ abi: IODBackerAbi, functionName: "openVaultFor", args: [owner, ref.id as `0x${string}`, collateral] })
      : encodeFunctionData({ abi: IODBackerAbi, functionName: "openVault", args: [ref.id as `0x${string}`, collateral] });
    return done("back_open", backer, data, [{ token: usdg(), spender: backer, amount: collateral }], { collateralUsdg: collateral, minCollateralUsdg: MIN_COLLATERAL_USDG }, forOther ? "Opens a vault owned by the given owner; the collateral comes from the sending wallet." : "Unsigned. Read the new vault id from the VaultOpened event.");
  });

  defineRoute(app, { method: "post", path: "/v1/intent/back/deposit", summary: "Unsigned deposit (top up collateral) transaction", tag: "quotes", auth: "public_rate_limited", body: DepositBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof DepositBody> }) => {
    const backer = addressOf("ODBacker");
    const amount = positive(body.usdg, "usdg");
    const found = await vaultOf(context, body.vaultId);
    if (found.response) return found.response;
    // A top-up is never blocked on chain (any session, pause or batch), so nothing here refuses it.
    return done("back_deposit", backer, encodeFunctionData({ abi: IODBackerAbi, functionName: "deposit", args: [found.id, amount] }), [{ token: usdg(), spender: backer, amount }], { vaultId: found.id, collateralUsdg: found.vault.collateralUsdg }, "Anyone may top up a vault. Never blocked.");
  });

  defineRoute(app, { method: "post", path: "/v1/intent/back/mint", summary: "Unsigned mint (or operator mintFor) transaction, health-checked", tag: "quotes", auth: "public_rate_limited", body: MintBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof MintBody> }) => {
    const backer = addressOf("ODBacker");
    const tokens = positive(body.tokens, "tokens");
    const found = await vaultOf(context, body.vaultId);
    if (found.response) return found.response;
    const { vault, id } = found;
    const asOperator = lower(vault.owner) !== lower(body.account);
    if (asOperator && !(await deps.chain.backerIsOperator(vault.owner, body.account))) throw new ApiError(400, "BAD_REQUEST", "Only the vault owner or an operator of the owner can mint.", "NOT_VAULT_OWNER");
    const sell = asOperator ? true : body.sellToGovernor;
    if (await deps.chain.backerMintPaused()) throw new ApiError(409, "PAUSED", "Minting is paused.", "MINT_PAUSED");
    await refuseInBatch(vault.batchId);
    const h = await deps.chain.backerHealth(id);
    const r = await reading(vault.gearId, ["STALE", "CLOSED", "PAUSED", "RESERVE_FLOOR"]);
    // per-token value: the live reading, else what the vault's own debt implies
    const perToken = r.value ?? (vault.debtTokens > 0n ? (h.debtValueWad * 10n ** 18n) / vault.debtTokens : null);
    if (perToken === null) throw new ApiError(409, "STALE", "No reading to value the new debt with.", "NO_READING");
    const estProceeds = sell ? (valueWad(tokens, perToken) / 10n ** 12n) * (10_000n - r.spreadBps) / 10_000n : 0n;
    const minProceeds = sell ? BigInt(body.minProceedsUsdg ?? minOutSuggested(estProceeds).toString()) : 0n;
    if (sell && minProceeds > estProceeds) throw new ApiError(400, "BAD_REQUEST", "minProceedsUsdg is above the estimated proceeds.", "MIN_ABOVE_ESTIMATE");
    const collateralAfter = vault.collateralUsdg + estProceeds;
    const debtAfter = h.debtValueWad + valueWad(tokens, perToken);
    const ratioAfter = healthBps(collateralAfter, debtAfter);
    if (ratioAfter < h.requiredBps) throw new ApiError(409, "BELOW_MIN", "The vault would fall below the required collateral ratio.", "UNDERCOLLATERALIZED");
    const data = asOperator
      ? encodeFunctionData({ abi: IODBackerAbi, functionName: "mintFor", args: [id, tokens, minProceeds] })
      : encodeFunctionData({ abi: IODBackerAbi, functionName: "mint", args: [id, tokens, sell, minProceeds] });
    return done("back_mint", backer, data, [], { ratioAfterBps: ratioAfter, requiredBps: h.requiredBps, maintenanceBps: h.maintenanceBps, estimatedProceedsUsdg: estProceeds, minProceedsUsdg: minProceeds }, "Pre-flight uses the live reading; the contract re-checks the ratio on its own high-side value. No approval is needed.", r.block);
  });

  defineRoute(app, { method: "post", path: "/v1/intent/back/repay", summary: "Unsigned repay (burn tokens) transaction", tag: "quotes", auth: "public_rate_limited", body: RepayBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof RepayBody> }) => {
    const backer = addressOf("ODBacker");
    const asked = positive(body.tokens, "tokens");
    const found = await vaultOf(context, body.vaultId);
    if (found.response) return found.response;
    if (found.vault.debtTokens === 0n) throw new ApiError(400, "BAD_REQUEST", "This vault has no debt to repay.", "NO_DEBT");
    // The contract clamps to the debt; the intent says the clamped amount. Burns the sender's own gear tokens: no approval.
    const tokens = asked > found.vault.debtTokens ? found.vault.debtTokens : asked;
    return done("back_repay", backer, encodeFunctionData({ abi: IODBackerAbi, functionName: "repay", args: [found.id, tokens] }), [], { tokens, debtTokens: found.vault.debtTokens }, "Burns gear tokens from the sending wallet. Never blocked, in any session or batch.");
  });

  defineRoute(app, { method: "post", path: "/v1/intent/back/repay-usdg", summary: "Unsigned repayWithUsdg transaction (buys the debt back from collateral)", tag: "quotes", auth: "public_rate_limited", body: RepayUsdgBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof RepayUsdgBody> }) => {
    const backer = addressOf("ODBacker");
    const asked = positive(body.tokens, "tokens");
    const found = await vaultOf(context, body.vaultId);
    if (found.response) return found.response;
    const { vault, id } = found;
    requireOwner(vault.owner, body.account);
    if (vault.debtTokens === 0n) throw new ApiError(400, "BAD_REQUEST", "This vault has no debt to repay.", "NO_DEBT");
    const tokens = asked > vault.debtTokens ? vault.debtTokens : asked;
    const r = await reading(vault.gearId, ["STALE", "CLOSED"]);
    if (r.value === null) throw new ApiError(409, "STALE", "No live reading to price the buy-back.", "NO_READING");
    const cost = (((valueWad(tokens, r.value) / 10n ** 12n) * (10_000n + r.spreadBps)) + 9_999n) / 10_000n;
    const maxCost = BigInt(body.maxCostUsdg ?? (cost + (cost * 50n) / 10_000n + 1n).toString());
    if (maxCost < cost) throw new ApiError(400, "BAD_REQUEST", "maxCostUsdg is below the estimated cost.", "MAX_BELOW_ESTIMATE");
    if (cost > vault.collateralUsdg) throw new ApiError(409, "BELOW_MIN", "The vault's collateral cannot pay this buy-back.", "INSUFFICIENT_COLLATERAL");
    return done("back_repay_usdg", backer, encodeFunctionData({ abi: IODBackerAbi, functionName: "repayWithUsdg", args: [id, tokens, maxCost] }), [], { tokens, estimatedCostUsdg: cost, maxCostUsdg: maxCost, collateralUsdg: vault.collateralUsdg }, "Paid from the vault's collateral at the live buy price. Needs a live reading; otherwise repay with tokens.", r.block);
  });

  defineRoute(app, { method: "post", path: "/v1/intent/back/withdraw", summary: "Unsigned withdraw transaction, health-checked", tag: "quotes", auth: "public_rate_limited", body: WithdrawBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof WithdrawBody> }) => {
    const backer = addressOf("ODBacker");
    const amount = positive(body.usdg, "usdg");
    const found = await vaultOf(context, body.vaultId);
    if (found.response) return found.response;
    const { vault, id } = found;
    requireOwner(vault.owner, body.account);
    if (amount > vault.collateralUsdg) throw new ApiError(400, "BAD_REQUEST", "More than the vault's collateral.", "ABOVE_COLLATERAL");
    await refuseInBatch(vault.batchId);
    const pre: Record<string, bigint> = { collateralUsdg: vault.collateralUsdg, withdrawUsdg: amount };
    let block: bigint | undefined;
    if (vault.debtTokens > 0n) {
      const h = await deps.chain.backerHealth(id);
      const r = await reading(vault.gearId, ["STALE"]);
      block = r.block;
      const ratioAfter = healthBps(vault.collateralUsdg - amount, h.debtValueWad);
      if (ratioAfter < h.requiredBps) throw new ApiError(409, "BELOW_MIN", "The vault would fall below the required collateral ratio.", "UNDERCOLLATERALIZED");
      pre.ratioAfterBps = ratioAfter; pre.requiredBps = h.requiredBps;
    }
    const to = (body.to ?? body.account) as `0x${string}`;
    return done("back_withdraw", backer, encodeFunctionData({ abi: IODBackerAbi, functionName: "withdraw", args: [id, amount, to] }), [], pre, "With debt, the ratio after must stay at or above the initial ratio. Never in a live batch.", block);
  });

  // ------------------------------------------------------------------------------------------ queued sells
  async function ticketOf(context: any, raw: string) {
    const t = await deps.chain.queuedSell(BigInt(raw));
    if (lower(t.owner) === ZERO_ADDRESS) return { response: notFound(context, "Unknown, filled or cancelled ticket.") };
    return { ticket: t, id: BigInt(raw) };
  }
  defineRoute(app, { method: "post", path: "/v1/intent/queue/cancel", summary: "Unsigned cancelQueued transaction (ticket owner)", tag: "quotes", auth: "public_rate_limited", body: CancelBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof CancelBody> }) => {
    const minter = addressOf("ODMinter");
    const found = await ticketOf(context, body.ticket);
    if (found.response) return found.response;
    if (lower(found.ticket.owner) !== lower(body.account)) throw new ApiError(400, "BAD_REQUEST", "Only the ticket owner can cancel.", "NOT_TICKET_OWNER");
    return done("queue_cancel", minter, encodeFunctionData({ abi: IODMinterAbi, functionName: "cancelQueued", args: [found.id] }), [], { ticket: found.id, tokens: found.ticket.tokens }, "Returns your tokens. Never blocked.");
  });
  defineRoute(app, { method: "post", path: "/v1/intent/queue/fill", summary: "Unsigned fillQueued transaction (anyone, at the next fresh price)", tag: "quotes", auth: "public_rate_limited", body: FillBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof FillBody> }) => {
    const minter = addressOf("ODMinter");
    const found = await ticketOf(context, body.ticket);
    if (found.response) return found.response;
    const gear = deps.deployment.gears.find((g) => lower(g.id) === lower(found.ticket.gearId));
    if (!gear) return notFound(context, "The ticket's gear is not in this deployment.");
    // Fillable now only when a fresh sell of the same size pays at least the ticket's minimum.
    const o = await service.quote({ gear: lower(gear.id), side: "sell", exactIn: found.ticket.tokens });
    if (o.sellMode === "queued" || !o.buyable || !o.v4) throw new ApiError(409, (o.refusal?.code === "QUEUED" || !o.refusal ? "UPSTREAM" : o.refusal.code) as ErrorCode, "This ticket cannot be filled now.", o.refusal?.reason ?? "NOT_PAYABLE_NOW");
    if (o.v4.amountOut < found.ticket.minUsdgOut) throw new ApiError(409, "BELOW_MIN", "The price now is below the ticket's minimum.", "BELOW_TICKET_MIN");
    return done("queue_fill", minter, encodeFunctionData({ abi: IODMinterAbi, functionName: "fillQueued", args: [found.id] }), [], { ticket: found.id, expectedOut: o.v4.amountOut, minUsdgOut: found.ticket.minUsdgOut }, "Anyone can send this. Pays the ticket's recipient at the fresh price.", o.blockNumber);
  });

  // ------------------------------------------------------------------------------------------ agent router
  defineRoute(app, { method: "post", path: "/v1/intent/agent/policy", summary: "Unsigned setPolicy transaction (grant an agent a spending policy)", tag: "quotes", auth: "public_rate_limited", body: PolicyBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (context, { body }: { body: z.infer<typeof PolicyBody> }) => {
    const router = addressOf("ODAgentRouter");
    if (lower(body.agent) === lower(body.account) || lower(body.agent) === ZERO_ADDRESS) throw new ApiError(400, "BAD_REQUEST", "The agent must be another, non-zero address.", "INVALID_POLICY");
    const budget = positive(body.budgetUsdg, "budgetUsdg");
    const perTrade = positive(body.maxPerTradeUsdg, "maxPerTradeUsdg");
    if (budget > UINT128_MAX || perTrade > UINT128_MAX) throw new ApiError(400, "BAD_REQUEST", "Amount too large.", "OUT_OF_RANGE");
    if (perTrade > budget) throw new ApiError(400, "BAD_REQUEST", "maxPerTradeUsdg is above budgetUsdg.", "INVALID_POLICY");
    if (BigInt(body.expiresAt) <= BigInt(Math.floor(nowOf(deps).getTime() / 1000))) throw new ApiError(400, "BAD_REQUEST", "expiresAt is in the past.", "INVALID_POLICY");
    const markets: `0x${string}`[] = [];
    for (const m of body.markets) {
      const found = resolveMarket(deps.deployment, m);
      if (!found) return notFound(context, `Unknown market ${m}.`);
      if (!markets.includes(found.id as `0x${string}`)) markets.push(found.id as `0x${string}`);
    }
    const data = encodeFunctionData({ abi: IODAgentRouterAbi, functionName: "setPolicy", args: [body.agent as `0x${string}`, budget, perTrade, BigInt(body.expiresAt), body.canSell, body.canBack, markets] });
    return done("agent_policy", router, data, [{ token: usdg(), spender: router, amount: budget }], { budgetUsdg: budget, maxPerTradeUsdg: perTrade, expiresAt: String(body.expiresAt), markets: String(markets.length) }, "The router pulls USDG from you when the agent trades, so the approval must cover the budget. Spending is lifetime: a new policy for the same agent keeps what it already spent.");
  });
  defineRoute(app, { method: "post", path: "/v1/intent/agent/revoke", summary: "Unsigned revoke transaction (end an agent's policy)", tag: "quotes", auth: "public_rate_limited", body: RevokeBody, response: ActionIntent, errors: [400, 404, 409, 502] }, async (_context, { body }: { body: z.infer<typeof RevokeBody> }) => {
    const router = addressOf("ODAgentRouter");
    return done("agent_revoke", router, encodeFunctionData({ abi: IODAgentRouterAbi, functionName: "revoke", args: [body.agent as `0x${string}`] }), [], { agent: body.agent }, "Ends the policy now. Also set the USDG approval to the router back to zero if you no longer want it.");
  });
}
