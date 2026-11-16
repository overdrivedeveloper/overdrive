// The website's procedures (handoff api-contracts.ts) as REST routes under /v1/compat/<procedure>. Each one reads our own /v1
// routes through an in-process copy of the API (same rules, same cache, no second rate limit) and reshapes the answer.
// Errors are only the 14 ServiceErrorCode values. Reads only: intents are unsigned and the API never sends.
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { decodeFunctionData, type Abi } from "viem";
import { IODBackerAbi, IODMinterAbi, IODStakeAbi } from "../../abi";
import { ROUTE_TABLE } from "../route-kit";
import { z } from "../schemas";
import { asRows, nowOf, type ApiDependencies } from "../types";
import {
  CompatError, SERVICE_ERROR_CODES, availabilityOf, backerVaultOf, bpsToPct, fromApiError, gearSnapshotOf, gearToken, governorSnapshotOf, marketGearOf,
  minimumOf, positionOf, raceVolBlocked, serviceError, stampOf, usdgToken, type GearDoc, type ServiceErrorCode,
} from "./model";

export const COMPAT_PREFIX = "/v1/compat";
export const COMPAT_PROCEDURES = [
  "market.list", "gear.snapshot", "trade.quote", "trade.status", "exit.queueStatus", "portfolio.positions",
  "backer.vaults", "backer.quoteAction", "governor.snapshot", "stake.account", "stake.quoteAction", "activity.list",
] as const;
export const COMPAT_POSTS = ["trade.quote", "backer.quoteAction", "stake.quoteAction"] as const;
export const INTENT_TTL_MS = 60_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

// ---------- OpenAPI shapes (documentation; the handlers build these exact objects) ----------
const Stamp = z.object({ chainId: z.number(), blockNumber: z.string(), observedAt: z.string() });
const Token = z.object({ address: z.string(), symbol: z.string(), decimals: z.number() });
const Amount = z.object({ token: Token, baseUnits: z.string().openapi({ description: "Integer in the token's base units." }) });
const snapshotOf = (data: z.ZodTypeAny, name: string) => z.object({ data: data.nullable(), stamp: Stamp, stale: z.boolean(), unavailableReason: z.string().optional() }).openapi(name);
const Intent = z.object({ chainId: z.number(), account: z.string(), contract: z.string(), functionName: z.string(), args: z.array(z.unknown()), valueBaseUnits: z.string(), expiresAt: z.string() });
const Approval = z.object({ token: Token, spender: z.string(), requiredBaseUnits: z.string(), method: z.enum(["approve", "verified_permit"]) });
const MarketGear = z.object({
  id: z.string(), underlying: z.string(), gear: z.string(), power: z.string(), token: Token.nullable(), poolId: z.string().nullable(), availability: z.string(), reason: z.string().optional(),
  canBuy: z.boolean(), canSell: z.boolean(), canQueueSell: z.boolean(), capUsd: z.string(), openValueUsd: z.string().nullable(), spreadBps: z.number(),
});
const GearSnapshot = z.object({
  gearId: z.string(), underlyingPrice: z.string().nullable(), valuePerToken: z.string().nullable(), priceCurrency: z.literal("USDG"), normalisation: z.string().nullable(),
  annualVolatilityPct: z.string().nullable(), dailyTollPct: z.string().nullable(), usageDailyTollPct: z.string().nullable(), availability: z.string(), feedUpdatedAt: z.string(), raceEligible: z.boolean(),
});
const QuoteInput = z.object({
  chainId: z.number().int(), account: z.string(), gearId: z.string(), side: z.enum(["buy", "sell"]), input: Amount, slippageBps: z.number().int(),
});
const Quote = z.object({
  id: z.string(), input: QuoteInput, stamp: Stamp, expiresAt: z.string(), execution: z.enum(["immediate", "queued"]), output: Amount, minimumOutput: Amount,
  dailyTollPct: z.string().nullable(), spreadBps: z.number(), priceImpactPct: z.string(), gasEstimateBaseUnits: z.string().nullable(), approvals: z.array(Approval), transaction: Intent,
  sellMode: z.enum(["instant", "instant_min", "queued"]).nullable().openapi({ description: "Sells only (null for a buy). instant: the market is open. instant_min: the market is closed, a sell now pays the lower of the last value and the reference value. queued: no fresh price, the sell waits for the next fresh price." }),
}).openapi("CompatQuote");
const ActionQuote = z.object({ id: z.string(), stamp: Stamp, expiresAt: z.string(), approvals: z.array(Approval), transaction: Intent }).openapi("CompatActionQuote");
const TxEvent = z.object({
  id: z.string(), chainId: z.number(), account: z.string().nullable(), kind: z.string(), timestamp: z.string().nullable(), transactionHash: z.string(),
  status: z.enum(["submitted", "confirming", "confirmed", "failed", "replaced"]), replacementHash: z.string().optional(), blockNumber: z.string().nullable(), summary: z.string(),
});
const Position = z.object({ gearId: z.string(), quantity: Amount, valueUsd: z.string().nullable(), accruedTollUsd: z.string().nullable() });
const Vault = z.object({
  id: z.string(), owner: z.string(), gearId: z.string(), collateral: Amount, debt: Amount, collateralRatioPct: z.string().nullable(), initialRatioPct: z.string(),
  maintenanceRatioPct: z.string(), health: z.string().nullable(), weekendUpliftPct: z.string(), canMint: z.boolean(), status: z.string(),
});
const Governor = z.object({ equityUsd: z.string(), exitReserveUsd: z.string(), exitReserveFloorUsd: z.string(), deltaUsd: z.string(), gammaUsd: z.string(), hedgeDeltaUsd: z.string(), riskState: z.enum(["normal", "reduced", "paused"]) });
const Stake = z.object({ available: Amount, staked: Amount, slashable: Amount, feeDiscountBps: z.number(), termsVersion: z.string(), unstakeAvailableAt: z.string().nullable() });
const QueueRow = z.object({ ticket: z.string(), gearId: z.string(), account: z.string(), quantity: Amount, minimumOutput: Amount, createdAt: z.string(), status: z.string(), canCancel: z.boolean(), settlement: z.string() });
const ServiceErrorBody = z.object({ code: z.enum(SERVICE_ERROR_CODES), message: z.string(), retryable: z.boolean(), retryAfterMs: z.number().optional() }).openapi("ServiceError");

type Inner = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

/** Registers the 12 procedures. `inner` is an in-process API without the compat routes and without its own rate limit. */
export function registerCompatRoutes(app: OpenAPIHono, deps: ApiDependencies, inner: () => Inner): void {
  const d = deps.deployment;
  const now = () => nowOf(deps);
  const fail = (code: ServiceErrorCode, message?: string): never => { throw new CompatError(serviceError(code, message)); };
  const badInput = (what: string): never => { throw new CompatError(serviceError("SERVICE_UNAVAILABLE", `Invalid request: ${what}.`), 400); };
  const fromBody = (status: number, body: any, side: "buy" | "sell" | null): never => {
    if (status === 429) throw new CompatError(serviceError("SERVICE_UNAVAILABLE", "Too many requests.", 60_000), 429);
    if (status === 400) badInput(String(body?.message ?? "rejected by the API"));
    throw new CompatError(serviceError(fromApiError(body?.error, body?.reason, side)));
  };
  const read = async (path: string, side: "buy" | "sell" | null = null, init?: RequestInit): Promise<any> => {
    const r = await inner().request(path, init);
    const body = await r.json().catch(() => null);
    if (r.status !== 200) fromBody(r.status, body, side);
    return body;
  };
  const post = (path: string, body: unknown, side: "buy" | "sell" | null = null) => read(path, side, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const checkChain = (raw: unknown) => {
    if (raw === undefined || raw === null || raw === "") return;
    if (Number(raw) !== d.chainId) fail("WRONG_CHAIN", `This service reads chain ${d.chainId}.`);
  };
  const account = (raw: unknown): string => (typeof raw === "string" && ADDRESS.test(raw) ? raw : badInput("account must be a 0x address"));
  const gearOf = (raw: unknown) => {
    if (typeof raw !== "string" || raw.length < 1 || raw.length > 80) return badInput("gearId");
    const key = raw.toLowerCase();
    const g = d.gears.find((x) => x.symbol.toLowerCase() === key || x.id.toLowerCase() === key);
    return g ?? fail("NOT_DEPLOYED", "Unknown gear on this network.");
  };
  const toIntent = (acct: string, tx: { to: string; data: string; value: string }, abi: Abi, expiresAt: string) => {
    const decoded = decodeFunctionData({ abi, data: tx.data as `0x${string}` });
    return { chainId: d.chainId, account: acct, contract: tx.to, functionName: decoded.functionName, args: (decoded.args ?? []).map(plain), valueBaseUnits: tx.value, expiresAt };
  };
  const approvalsOf = (rows: Array<{ token: string; spender: string; amount: string }>) => rows.map((a) => ({
    token: a.token.toLowerCase() === d.external.usdg.toLowerCase() ? usdgToken(d) : d.gears.find((g) => g.token.toLowerCase() === a.token.toLowerCase()) ? gearToken(d, d.gears.find((g) => g.token.toLowerCase() === a.token.toLowerCase())!.symbol)! : { address: a.token, symbol: "OVRD", decimals: 18 },
    spender: a.spender, requiredBaseUnits: a.amount, method: "approve" as const,
  }));
  const snapshot = (data: unknown, doc: { asOfBlock?: string; asOf?: string; stale?: boolean }, unavailableReason?: string) =>
    ({ data, stamp: stampOf(d, doc, now()), stale: doc.stale ?? false, ...(unavailableReason ? { unavailableReason } : {}) });

  type Handler = (c: Context, q: Record<string, string | undefined>, body: any) => Promise<object>;
  const route = (method: "get" | "post", procedure: (typeof COMPAT_PROCEDURES)[number], summary: string, response: z.ZodTypeAny, handler: Handler, query: Record<string, string> = {}, body?: z.ZodTypeAny) => {
    const path = `${COMPAT_PREFIX}/${procedure}`;
    const spec = createRoute({
      method, path, summary, tags: ["compat"],
      description: "Website contract procedure. Amounts are integer strings in base units; missing values are null; errors are a ServiceError with one of 14 codes.",
      request: {
        ...(Object.keys(query).length ? { query: z.object(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, z.string().optional().openapi({ description: v })]))) } : {}),
        ...(body ? { body: { content: { "application/json": { schema: body } }, required: true } } : {}),
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: response } } },
        ...Object.fromEntries([400, 404, 409, 429, 503].map((s) => [s, { description: "ServiceError", content: { "application/json": { schema: ServiceErrorBody } } }])),
      },
    });
    if (!ROUTE_TABLE.some((r) => r.method === method.toUpperCase() && r.path === path)) ROUTE_TABLE.push({ method: method.toUpperCase() as "GET" | "POST", path, auth: method === "post" ? "public_rate_limited" : "public", tag: "compat" });
    // Validation is done in the handler so that a bad request still answers with a ServiceError, never another code.
    (app as any).openapi(spec, async (c: Context) => {
      try {
        let json: unknown;
        if (method === "post") json = await c.req.json().catch(() => badInput("body must be JSON"));
        c.header("Cache-Control", method === "post" ? "no-store" : "public, max-age=5");
        return c.json(await handler(c, c.req.query(), json), 200);
      } catch (error) {
        const e = error instanceof CompatError ? error : new CompatError(serviceError("SERVICE_UNAVAILABLE"));
        if (!(error instanceof CompatError)) deps.logger.error({ procedure }, "compat procedure failed");
        c.header("Cache-Control", "no-store");
        if (e.body.retryAfterMs) c.header("Retry-After", String(Math.ceil(e.body.retryAfterMs / 1000)));
        return c.json(e.body, e.status);
      }
    }, (result: { success: boolean }, c: Context) => {
      if (!result.success) return c.json(serviceError("SERVICE_UNAVAILABLE", "Invalid request: body or query shape."), 400);
    });
  };

  route("get", "market.list", "Catalog with stable ids, deployed addresses and live availability", snapshotOf(z.array(MarketGear), "CompatMarketList"), async (_c, q) => {
    checkChain(q.chainId);
    const doc = await read("/v1/gears");
    return snapshot((doc.gears as GearDoc[]).map((g) => marketGearOf(d, g)), doc);
  }, { chainId: "Must equal the service chain when given." });

  route("get", "gear.snapshot", "Price, value per token, normalisation, volatility, daily toll and availability of one gear", snapshotOf(GearSnapshot, "CompatGearSnapshot"), async (_c, q) => {
    checkChain(q.chainId);
    const g = gearOf(q.gearId);
    const doc = await read(`/v1/gears/${encodeURIComponent(g.symbol)}`);
    return snapshot(gearSnapshotOf(d, doc.gear, doc.asOf), doc);
  }, { gearId: "Gear symbol (TSLA-SPORT) or bytes32 id.", chainId: "Optional chain check." });

  route("post", "trade.quote", "A bounded quote with its unsigned transaction intent", Quote, async (_c, _q, b) => {
    checkChain(b.chainId);
    const acct = account(b.account);
    const g = gearOf(b.gearId);
    const side = b.side as "buy" | "sell";
    if (!UINT.test(b.input.baseUnits) || BigInt(b.input.baseUnits) <= 0n) badInput("input.baseUnits must be a positive integer string");
    if (!Number.isInteger(b.slippageBps) || b.slippageBps < 0 || b.slippageBps > 1000) badInput("slippageBps must be 0..1000");
    const inToken = side === "buy" ? usdgToken(d) : gearToken(d, g.symbol) ?? fail("NOT_DEPLOYED");
    if (b.input.token.address.toLowerCase() !== inToken.address.toLowerCase()) badInput(`input token must be ${inToken.symbol}`);
    const amount = BigInt(b.input.baseUnits);
    const gearDoc = await read(`/v1/gears/${encodeURIComponent(g.symbol)}`);
    const a = availabilityOf(d, gearDoc.gear);
    if (side === "buy" && raceVolBlocked(gearDoc.gear)) fail("RACE_VOL_LIMIT");
    if (a.availability === "not_deployed") fail("NOT_DEPLOYED");
    if (side === "sell") {
      const held = await read(`/v1/account/${acct}`);
      const row = (held.balances as Array<{ gear: string; balance: string }>).find((x) => x.gear === g.symbol);
      if (!row || BigInt(row.balance) < amount) fail("INSUFFICIENT_BALANCE");
    }
    const amountKey = side === "buy" ? "usdg" : "tokens";
    const qd = await read(`/v1/quote?gear=${encodeURIComponent(g.symbol)}&side=${side}&${amountKey}=${amount}&account=${acct}`, side);
    const queued = side === "sell" && qd.sellMode === "queued";
    if (!qd.buyable && !queued) fail(fromApiError(qd.code, qd.reason, side));
    const expected = BigInt(queued ? qd.amountOut ?? "0" : qd.amountOut);
    const minOut = minimumOf(expected, b.slippageBps);
    const deadlineSec = Math.max(30, Math.round(INTENT_TTL_MS / 1000));
    const intent = await post(`/v1/intent/${side}`, { gear: g.symbol, account: acct, [amountKey]: amount.toString(), minOut: minOut.toString(), deadlineSec }, side);
    const expiresAt = new Date(Math.min(Date.parse(qd.expiresAt), now().getTime() + INTENT_TTL_MS)).toISOString();
    const outToken = side === "buy" ? gearToken(d, g.symbol)! : usdgToken(d);
    return {
      id: intent.quoteId, input: { chainId: d.chainId, account: acct, gearId: g.symbol, side, input: { token: inToken, baseUnits: amount.toString() }, slippageBps: b.slippageBps },
      stamp: stampOf(d, intent, now()), expiresAt, execution: intent.kind === "queue_sell" ? "queued" : "immediate",
      output: { token: outToken, baseUnits: String(intent.expectedOut) }, minimumOutput: { token: outToken, baseUnits: String(intent.minOut) },
      dailyTollPct: bpsToPct(qd.tollPerDayBps), spreadBps: qd.spreadBps ?? g.spreadBps,
      // The price is the oracle value plus the spread; there is no pool curve, so no further impact.
      priceImpactPct: "0", gasEstimateBaseUnits: null,
      approvals: approvalsOf(intent.approvals), transaction: toIntent(acct, intent.tx, IODMinterAbi as Abi, expiresAt),
      sellMode: side === "sell" ? (queued ? "queued" : qd.sellMode ?? null) : null,
    };
  }, {}, QuoteInput);

  route("get", "trade.status", "Receipt or indexed status of a submitted transaction", snapshotOf(TxEvent, "CompatTradeStatus"), async (_c, q) => {
    checkChain(q.chainId);
    const hash = typeof q.hash === "string" && HASH.test(q.hash) ? q.hash.toLowerCase() : badInput("hash");
    const [trade] = asRows<any>(await deps.sql`SELECT tx_hash, log_index, block, ts, account, side, gear FROM trades WHERE tx_hash = ${hash} ORDER BY log_index LIMIT 1`);
    const cursor = asRows<any>(await deps.sql`SELECT block, updated_at FROM cursors WHERE name = 'main'`)[0];
    const doc = { asOfBlock: cursor ? String(cursor.block) : "0", asOf: now().toISOString() };
    const base = { id: hash, chainId: d.chainId, transactionHash: hash };
    if (trade) {
      const sym = d.gears.find((x) => x.id.toLowerCase() === String(trade.gear).toLowerCase())?.symbol ?? trade.gear;
      return snapshot({ ...base, account: trade.account, kind: trade.side, timestamp: new Date(trade.ts).toISOString(), status: "confirmed", blockNumber: String(trade.block), summary: `${trade.side} ${sym}` }, doc);
    }
    if (!deps.chain.receipt) return snapshot({ ...base, account: null, kind: "unknown", timestamp: null, status: "submitted", blockNumber: null, summary: "Not indexed yet." }, doc, "receipt reads are not available");
    const r = await deps.chain.receipt(hash).catch(() => fail("SERVICE_UNAVAILABLE"));
    if (!r) return snapshot({ ...base, account: null, kind: "unknown", timestamp: null, status: "submitted", blockNumber: null, summary: "Not mined yet." }, doc);
    const status = r.status === "reverted" ? "failed" : cursor && BigInt(cursor.block) >= r.blockNumber ? "confirmed" : "confirming";
    return snapshot({ ...base, account: null, kind: "transaction", timestamp: null, status, blockNumber: r.blockNumber.toString(), summary: status === "failed" ? "Reverted on chain." : "Mined." }, doc);
  }, { hash: "Transaction hash.", chainId: "Optional chain check." });

  route("get", "exit.queueStatus", "A wallet's queued sells with their settlement rule", snapshotOf(z.array(QueueRow), "CompatExitQueue"), async (_c, q) => {
    checkChain(q.chainId);
    const acct = account(q.account);
    const [held, exit] = await Promise.all([read(`/v1/account/${acct}`), read("/v1/exit")]);
    const rules = new Map<string, string>((exit.gears as Array<{ symbol: string; rule: string }>).map((g) => [g.symbol, g.rule]));
    const rows = (held.queuedSells as Array<{ ticket: string; gear: string; tokens: string; minProceedsUsdg: string; queuedAt: string }>).map((s) => ({
      ticket: s.ticket, gearId: s.gear, account: acct, quantity: { token: gearToken(d, s.gear) ?? { address: "0x0000000000000000000000000000000000000000", symbol: s.gear, decimals: 18 }, baseUnits: s.tokens },
      minimumOutput: { token: usdgToken(d), baseUnits: s.minProceedsUsdg }, createdAt: s.queuedAt, status: "open", canCancel: true,
      settlement: rules.get(s.gear) ?? "Paid at the next fresh price, never below your minimum.",
    }));
    return snapshot(rows, held);
  }, { account: "Wallet address.", chainId: "Optional chain check." });

  route("get", "portfolio.positions", "A wallet's gear token quantities and values", snapshotOf(z.array(Position), "CompatPositions"), async (_c, q) => {
    checkChain(q.chainId);
    const held = await read(`/v1/account/${account(q.account)}`);
    return snapshot((held.balances as any[]).map((b) => positionOf(d, b)), held);
  }, { account: "Wallet address.", chainId: "Optional chain check." });

  route("get", "backer.vaults", "A wallet's backer vaults with health and current requirements", snapshotOf(z.array(Vault), "CompatVaults"), async (_c, q) => {
    checkChain(q.chainId);
    const doc = await read(`/v1/backers/${account(q.account)}`);
    return snapshot((doc.vaults as any[]).map((v) => backerVaultOf(d, v)), doc);
  }, { account: "Wallet address.", chainId: "Optional chain check." });

  route("post", "backer.quoteAction", "Unsigned backer transaction: open, deposit, withdraw, mint or repay", ActionQuote, async (_c, _q, b) => {
    checkChain(b.chainId);
    const acct = account(b.account);
    if (typeof b.amount !== "string" || !UINT.test(b.amount)) badInput("amount");
    const vaultId = () => (typeof b.vaultId === "string" && /^\d{1,30}$/.test(b.vaultId) ? b.vaultId : badInput("vaultId"));
    let path: string; let body: Record<string, unknown>;
    switch (b.action) {
      case "open": path = "back/open"; body = { gear: gearOf(b.gearId).symbol, account: acct, collateralUsdg: b.amount }; break;
      case "deposit": path = "back/deposit"; body = { account: acct, vaultId: vaultId(), usdg: b.amount }; break;
      case "withdraw": path = "back/withdraw"; body = { account: acct, vaultId: vaultId(), usdg: b.amount }; break;
      case "mint": path = "back/mint"; body = { account: acct, vaultId: vaultId(), tokens: b.amount }; break;
      case "repay": path = "back/repay"; body = { account: acct, vaultId: vaultId(), tokens: b.amount }; break;
      default: return badInput("action must be open, deposit, withdraw, mint or repay");
    }
    const intent = await post(`/v1/intent/${path}`, body);
    const expiresAt = new Date(now().getTime() + INTENT_TTL_MS).toISOString();
    return { id: `${intent.kind}:${intent.blockNumber}`, stamp: stampOf(d, intent, now()), expiresAt, approvals: approvalsOf(intent.approvals), transaction: toIntent(acct, intent.tx, IODBackerAbi as Abi, expiresAt) };
  }, {}, z.object({ chainId: z.number().int(), account: z.string(), action: z.enum(["open", "deposit", "withdraw", "mint", "repay"]), gearId: z.string().optional(), vaultId: z.string().optional(), amount: z.string() }));

  route("get", "governor.snapshot", "Governor equity, exit reserve and floor, exposures and risk state", snapshotOf(Governor, "CompatGovernor"), async (_c, q) => {
    checkChain(q.chainId);
    const doc = await read("/v1/governor");
    return snapshot(governorSnapshotOf(doc), { ...doc, stale: doc.stale || !doc.live });
  }, { chainId: "Optional chain check." });

  const stakeAddress = () => (ADDRESS.test(d.contracts.ODStake ?? "") ? d.contracts.ODStake : null);
  const stakedOf = async (acct: string) => {
    const rows = asRows<any>(await deps.sql`SELECT kind, amount, detail, block FROM stake_events WHERE account = ${acct.toLowerCase()} ORDER BY block, log_index`);
    let staked = 0n; let readyAt: string | null = null;
    for (const r of rows) {
      if (r.kind === "Staked" && r.amount !== null) staked += BigInt(r.amount);
      if (r.kind === "Unstaked") { staked -= BigInt((typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail)?.amount ?? r.amount ?? 0); readyAt = null; }
      if (r.kind === "UnstakeRequested") { const at = Number((typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail)?.readyAt ?? 0); readyAt = at > 0 ? new Date(at * 1000).toISOString() : null; }
    }
    return { staked: staked < 0n ? 0n : staked, readyAt };
  };
  route("get", "stake.account", "OVRD available and staked, slashable amount, fee discount and terms", snapshotOf(Stake, "CompatStake"), async (_c, q) => {
    checkChain(q.chainId);
    const acct = account(q.account);
    if (!stakeAddress()) return snapshot(null, { asOf: now().toISOString() }, "NOT_DEPLOYED");
    if (!deps.chain.stakeAccount) return snapshot(null, { asOf: now().toISOString() }, "SERVICE_UNAVAILABLE");
    const [s, ev] = await Promise.all([deps.chain.stakeAccount(acct).catch(() => fail("SERVICE_UNAVAILABLE")), stakedOf(acct)]);
    const token = { address: s.ovrd, symbol: "OVRD", decimals: 18 };
    return snapshot({
      available: { token, baseUnits: s.balance.toString() }, staked: { token, baseUnits: ev.staked.toString() }, slashable: { token, baseUnits: ev.staked.toString() },
      feeDiscountBps: s.feeDiscountBps, termsVersion: d.commit, unstakeAvailableAt: ev.readyAt,
    }, { asOfBlock: s.blockNumber.toString(), asOf: now().toISOString() });
  }, { account: "Wallet address.", chainId: "Optional chain check." });

  route("post", "stake.quoteAction", "Unsigned stake, requestUnstake or unstake transaction", ActionQuote, async (_c, _q, b) => {
    checkChain(b.chainId);
    const acct = account(b.account);
    const stake = stakeAddress() ?? fail("NOT_DEPLOYED", "Staking is not deployed on this network.");
    if (!deps.chain.stakeAccount) fail("SERVICE_UNAVAILABLE");
    const s = await deps.chain.stakeAccount!(acct).catch(() => fail("SERVICE_UNAVAILABLE"));
    const amount = b.action === "unstake" ? 0n : typeof b.amount === "string" && UINT.test(b.amount) && BigInt(b.amount) > 0n ? BigInt(b.amount) : badInput("amount");
    if (b.action === "stake" && s.balance < amount) fail("INSUFFICIENT_BALANCE");
    if (b.action === "requestUnstake" && (await stakedOf(acct)).staked === 0n) fail("INSUFFICIENT_BALANCE");
    const functionName = b.action === "stake" ? "stake" : b.action === "requestUnstake" ? "requestUnstake" : b.action === "unstake" ? "unstake" : badInput("action must be stake, requestUnstake or unstake");
    if (!IODStakeAbi.some((x: any) => x.type === "function" && x.name === functionName)) fail("NOT_DEPLOYED");
    const expiresAt = new Date(now().getTime() + INTENT_TTL_MS).toISOString();
    return {
      id: `${functionName}:${s.blockNumber}`, stamp: { chainId: d.chainId, blockNumber: s.blockNumber.toString(), observedAt: now().toISOString() }, expiresAt,
      approvals: b.action === "stake" ? [{ token: { address: s.ovrd, symbol: "OVRD", decimals: 18 }, spender: stake, requiredBaseUnits: amount.toString(), method: "approve" as const }] : [],
      transaction: { chainId: d.chainId, account: acct, contract: stake, functionName, args: functionName === "unstake" ? [] : [amount.toString()], valueBaseUnits: "0", expiresAt },
    };
  }, {}, z.object({ chainId: z.number().int(), account: z.string(), action: z.enum(["stake", "requestUnstake", "unstake"]), amount: z.string().optional() }));

  route("get", "activity.list", "A wallet's indexed on-chain events, newest first, paged by cursor", z.object({ rows: z.array(TxEvent), nextCursor: z.string().nullable() }).openapi("CompatActivity"), async (_c, q) => {
    checkChain(q.chainId);
    const acct = account(q.account).toLowerCase();
    const limit = q.limit === undefined ? 50 : /^\d{1,3}$/.test(q.limit) && Number(q.limit) >= 1 && Number(q.limit) <= 200 ? Number(q.limit) : badInput("limit 1..200");
    const [cb, cl] = q.cursor === undefined ? [null, null] : /^\d{1,20}:\d{1,9}$/.test(q.cursor) ? q.cursor.split(":") : badInput("cursor");
    const rows = asRows<any>(await deps.sql`
      SELECT * FROM (
        SELECT tx_hash, log_index, block, ts, side AS kind, gear, tokens::text AS a, usdg::text AS b FROM trades WHERE lower(account) = ${acct}
        UNION ALL SELECT tx_hash, log_index, block, ts, kind, NULL AS gear, amount::text AS a, NULL AS b FROM stake_events WHERE account = ${acct}
      ) e WHERE ${cb === null} OR (block, log_index) < (${cb ?? "0"}::numeric, ${cl ?? "0"}::int)
      ORDER BY block DESC, log_index DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit).map((r) => {
      const sym = r.gear ? d.gears.find((x) => x.id.toLowerCase() === String(r.gear).toLowerCase())?.symbol ?? r.gear : null;
      return {
        id: `${r.tx_hash}:${r.log_index}`, chainId: d.chainId, account: acct, kind: String(r.kind), timestamp: new Date(r.ts).toISOString(), transactionHash: r.tx_hash,
        status: "confirmed" as const, blockNumber: String(r.block), summary: sym ? `${r.kind} ${sym}` : String(r.kind),
      };
    });
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { rows: page, nextCursor: last ? `${last.block}:${last.log_index}` : null };
  }, { account: "Wallet address.", cursor: "From nextCursor.", limit: "1..200, default 50.", chainId: "Optional chain check." });
}

/** bigint args as integer strings, everything else as is (addresses, bools, bytes32). */
function plain(v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(plain) : v;
}
