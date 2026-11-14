import { formatUnits, getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { ToolError, type ApiClient } from "./api-client";
import { encodeRouterCall, routerCallFromIntent, sendRouterCall, type AgentRuntime, type BackPlan, type Intent, type Mode, type RouterCall } from "./agent";
import { assertPinned, type PinnedDeployment, type ServedConfig } from "./pinned";

// Every string that came from the API or the chain is returned inside a `data` field. Tool descriptions are static. No
// tool result is ever built by concatenating API text into a sentence (R7).

export interface ToolContext {
  readonly api: ApiClient;
  /** Absent in read_only mode. */
  readonly agent: AgentRuntime | undefined;
  readonly mode: Mode;
  readonly defaultOwner: Address | undefined;
  readonly router: Address | undefined;
  readonly pin: PinnedDeployment | undefined;
  readonly now: () => number;
}

export interface ToolDefinition<T extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly input: T;
  readonly execution: boolean;
  readonly annotations?: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean; readonly openWorldHint: boolean };
  run(context: ToolContext, args: z.infer<T>): Promise<unknown>;
}
const defineTool = <T extends z.ZodObject>(tool: ToolDefinition<T>): ToolDefinition<T> => tool;

const WAD = 10n ** 18n;
const MIN_NEW_VAULT_USDG = 50_000_000n;
const rawInt = z.string().regex(/^[1-9]\d{0,38}$|^0$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const gearName = z.string().min(1).max(80).regex(/^[A-Za-z0-9./_-]+$/).describe("Gear symbol such as TSLA-SPORT, or its bytes32 id.");
const slippageBps = z.number().int().min(0).max(1_000).optional().describe("Allowed price move in basis points. Default 50.");
const deadlineSeconds = z.number().int().min(30).max(3_600).optional().describe("Seconds the order stays valid. Default 300.");
const owner = address.optional().describe("Account the position belongs to. Defaults to the configured owner.");
const BLOCKED = new Set(["CLOSED", "PAUSED", "CAP_REACHED", "STALE", "BELOW_MIN", "RESERVE_FLOOR", "UPSTREAM", "QUEUED"]);

const human = (raw: string | bigint, decimals: number) => formatUnits(BigInt(raw), decimals);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

// ------------------------------------------------------------------------------------------------------ config and pin
const configCache = new WeakMap<ApiClient, { at: number; value: Config }>();
interface Config extends ServedConfig {
  contracts: Record<string, string>; external: Record<string, string>;
  markets: Array<{ id: Hex; symbol: string }>;
  gears: Array<{ id: Hex; symbol: string; token: string; marketA: string; marketB: string | null }>;
}
/** The API's /v1/config, checked against the pin on every fresh read (R8). Cached for 30 s. */
async function readConfig(context: ToolContext): Promise<Config> {
  const cached = configCache.get(context.api);
  if (cached && context.now() - cached.at < 30_000) return cached.value;
  const value = await context.api.get("/v1/config") as Config;
  if (context.pin) assertPinned(context.pin, value);
  configCache.set(context.api, { at: context.now(), value });
  return value;
}
/** Start-up check: a pinned package refuses an API that serves other addresses before it answers anything. */
export async function verifyPin(api: ApiClient, pin: PinnedDeployment): Promise<void> {
  assertPinned(pin, await api.get("/v1/config") as ServedConfig);
}

function routerOf(context: ToolContext, config: Config): Address {
  const found = context.pin?.router ?? context.agent?.router ?? context.router ?? config.contracts.ODAgentRouter;
  if (!found) throw new ToolError("NO_ROUTER", "No agent router address is configured for this deployment.");
  return getAddress(found);
}
const minterOf = (context: ToolContext, config: Config): Address => getAddress(context.pin?.minter ?? config.contracts.ODMinter ?? (() => { throw new ToolError("NO_MINTER", "No minter address is configured for this deployment."); })());

function resolveGear(config: Config, key: string) {
  const k = key.toLowerCase();
  const g = config.gears.find((x) => x.symbol.toLowerCase() === k || x.id.toLowerCase() === k);
  if (!g) throw new ToolError("UNKNOWN_GEAR", "This gear is not in the deployment.");
  const market = (ref: string | null): Hex | null => ref === null ? null : (config.markets.find((m) => m.symbol.toLowerCase() === ref.toLowerCase() || m.id.toLowerCase() === ref.toLowerCase())?.id ?? null);
  const marketA = market(g.marketA);
  const marketB = g.marketB === null ? null : market(g.marketB);
  if (!marketA || (g.marketB !== null && !marketB)) throw new ToolError("UNKNOWN_MARKET", "The gear's market is not in the deployment.");
  return { id: g.id.toLowerCase() as Hex, symbol: g.symbol, token: g.token as Address, markets: [marketA, ...(marketB ? [marketB] : [])] as Hex[] };
}

function ownerOf(context: ToolContext, given: string | undefined): Address {
  const found = given ?? context.agent?.owner ?? context.defaultOwner;
  if (!found) throw new ToolError("OWNER_REQUIRED", "No owner account is configured. Set AGENT_OWNER or pass owner.");
  return getAddress(found);
}

function requireAgent(context: ToolContext): AgentRuntime {
  if (!context.agent || context.mode === "read_only") throw new ToolError("READ_ONLY", "This server holds no agent key, so it can quote and read but not trade.");
  return context.agent;
}

/** Quote first; a stale, closed, paused or capped answer is returned with the API's reason and never sent (R10). */
function assertTradable(quote: Record<string, unknown>): void {
  const code = typeof quote.code === "string" ? quote.code : null;
  const blocked = quote.stale === true || quote.buyable !== true || (code !== null && BLOCKED.has(code)) || quote.sellMode === "queued";
  if (blocked) {
    throw new ToolError(code && BLOCKED.has(code) ? code : quote.stale === true ? "STALE" : "NOT_EXECUTABLE", "The quote is not executable now, so nothing was prepared or sent.", { quote });
  }
}

interface Prepared { call: RouterCall; router: Address; owner: Address }
async function finish(context: ToolContext, prepared: Prepared, extra: Record<string, unknown>): Promise<unknown> {
  const { call, router, owner: ownerAddress } = prepared;
  if (context.mode === "send" && context.agent) {
    const { txHash } = await sendRouterCall(context.agent, router, call, ownerAddress);
    return { action: call.kind, status: "sent", txHash, router, owner: ownerAddress, agent: context.agent.account.address, ...extra };
  }
  return {
    action: call.kind, status: "prepared", note: "Prepared only: nothing was signed or sent. The agent signs this with its own key; the owner's on-chain policy is the limit.",
    router, owner: ownerAddress, tx: { to: router, data: encodeRouterCall(call), value: "0" }, ...extra,
  };
}

async function trade(context: ToolContext, kind: "buy" | "sell", args: { gear: string; amount: string; slippageBps?: number | undefined; deadlineSeconds?: number | undefined; owner?: string | undefined }): Promise<unknown> {
  requireAgent(context);
  const ownerAddress = ownerOf(context, args.owner);
  const config = await readConfig(context);
  const gear = resolveGear(config, args.gear);
  const amount = BigInt(args.amount);
  if (amount <= 0n) throw new ToolError("BAD_ARGUMENTS", "The amount must be above zero.");
  const slippage = BigInt(args.slippageBps ?? 50);
  const ttl = args.deadlineSeconds ?? 300;
  const query = kind === "buy" ? `usdg=${amount}` : `tokens=${amount}`;
  const quote = record(await context.api.get(`/v1/quote?gear=${encodeURIComponent(gear.id)}&side=${kind}&${query}&account=${ownerAddress}`));
  assertTradable(quote);
  const quoted = BigInt(typeof quote.amountOut === "string" ? quote.amountOut : "0");
  if (quoted <= 0n) throw new ToolError("NOT_EXECUTABLE", "The quote has no output.", { quote });
  const minOut = (quoted * (10_000n - slippage)) / 10_000n;
  const intent = await context.api.post(`/v1/intent/${kind}`, { gear: gear.id, account: ownerAddress, [kind === "buy" ? "usdg" : "tokens"]: amount.toString(), minOut: minOut.toString(), deadlineSec: ttl, recipient: ownerAddress }) as Intent;
  const nowSec = BigInt(Math.floor(context.now() / 1000));
  const call = routerCallFromIntent(kind, intent, ownerAddress, { gearId: gear.id, minter: minterOf(context, config), amount, minOut, markets: gear.markets, deadlineWithin: [nowSec, nowSec + BigInt(ttl) + 120n] });
  const router = routerOf(context, config);
  const deadline = call.args[4];
  const display = kind === "buy"
    ? { spendUsdg: human(amount, 6), minTokensOut: human(minOut, 18), expectedTokens: human(quoted, 18) }
    : { sellTokens: human(amount, 18), minUsdgOut: human(minOut, 6), expectedUsdg: human(quoted, 6) };
  return finish(context, { call, router, owner: ownerAddress }, { gear: gear.symbol, gearId: gear.id, amount: amount.toString(), expectedOut: quoted.toString(), minOut: minOut.toString(), deadline: deadline.toString(), display, data: { quote } });
}

// ---------------------------------------------------------------------------------------------------------- back maths
/** The price at which the ratio equals maintenance: value moves as price^p, so P* = P x (ratio / maintenance)^(1/p). Same rule as the API's vault view. */
export function liquidationPriceWad(priceWad: bigint, ratioBps: bigint, maintenanceBps: bigint, power: number): bigint | null {
  if (priceWad === 0n || ratioBps === 0n || maintenanceBps === 0n || power === 0) return null;
  const factor = Math.pow(Number(ratioBps) / Number(maintenanceBps), 1 / power);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return (priceWad * BigInt(Math.round(factor * 1e12))) / 10n ** 12n;
}
/** Collateral over debt value, in bps (collateral is 6 dp USDG, debt value is WAD USD). */
export const ratioBps = (collateralUsdg: bigint, debtValueWad: bigint): bigint => (debtValueWad === 0n ? 0n : (collateralUsdg * 10n ** 12n * 10_000n) / debtValueWad);

// ------------------------------------------------------------------------------------------------------------- tools
const gears = defineTool({
  name: "od_gears",
  description: "List the gears, or the gears of one underlying and power: value per token, daily toll in basis points, spread, cap, whether buys are open and the sell mode. Read only.",
  input: z.object({ underlying: z.string().min(1).max(40).regex(/^[A-Za-z0-9./_-]+$/).optional(), power: z.number().min(-1).max(3).optional() }).strict(),
  execution: false,
  async run(context, args) {
    const body = record(await context.api.get("/v1/gears"));
    let list = Array.isArray(body.gears) ? body.gears as Array<Record<string, unknown>> : [];
    if (args.underlying) list = list.filter((g) => String(g.underlying).toLowerCase() === args.underlying!.toLowerCase());
    if (args.power !== undefined) list = list.filter((g) => Number(g.power) === args.power);
    return { data: { ...body, gears: list }, count: list.length };
  },
});

const quote = defineTool({
  name: "od_quote",
  description: "Exact quote for a buy (usdg, raw 6 dp) or a sell (tokens, raw 18 dp) of one gear, from the on-chain quoter path: output, spread, daily toll, breakeven days and why it might be blocked. Read only.",
  input: z.object({ gear: gearName, side: z.enum(["buy", "sell"]), usdg: rawInt.optional(), tokens: rawInt.optional() }).strict(),
  execution: false,
  async run(context, args) {
    if (args.side === "buy" && !args.usdg) throw new ToolError("BAD_ARGUMENTS", "A buy quote needs usdg.");
    if (args.side === "sell" && !args.tokens) throw new ToolError("BAD_ARGUMENTS", "A sell quote needs tokens.");
    const amount = args.side === "buy" ? `usdg=${args.usdg}` : `tokens=${args.tokens}`;
    const q = record(await context.api.get(`/v1/quote?gear=${encodeURIComponent(args.gear)}&side=${args.side}&${amount}`));
    const code = typeof q.code === "string" ? q.code : null;
    // Stale, closed, paused and capped states are passed through, never hidden.
    return { data: q, executable: q.buyable === true && q.stale !== true && !(code && BLOCKED.has(code)), blockedCode: code && BLOCKED.has(code) ? code : null };
  },
});

const buy = defineTool({
  name: "od_buy_gear",
  description: "Buy a gear for the owner through the agent router, inside the owner's on-chain policy (budget, per-trade limit, expiry, markets). Tokens go to the owner. In prepare mode returns calldata and sends nothing.",
  input: z.object({ gear: gearName, usdg: rawInt, slippageBps, deadlineSeconds, owner }).strict(),
  execution: true,
  run: (context, args) => trade(context, "buy", { gear: args.gear, amount: args.usdg, slippageBps: args.slippageBps, deadlineSeconds: args.deadlineSeconds, owner: args.owner }),
});

const sell = defineTool({
  name: "od_sell_gear",
  description: "Sell gear tokens the owner holds, through the agent router, only when the owner's policy lets the agent sell. Proceeds go to the owner. A sell that can only be queued is refused. In prepare mode returns calldata and sends nothing.",
  input: z.object({ gear: gearName, tokens: rawInt, slippageBps, deadlineSeconds, owner }).strict(),
  execution: true,
  run: (context, args) => trade(context, "sell", { gear: args.gear, amount: args.tokens, slippageBps: args.slippageBps, deadlineSeconds: args.deadlineSeconds, owner: args.owner }),
});

const back = defineTool({
  name: "od_back",
  description: "Open (or top up, with vaultId) a backer vault through the router when the owner's policy allows backing: shows the collateral ratio and liquidation price first. Eco gears cannot be backed. In prepare mode returns calldata and sends nothing.",
  input: z.object({
    gear: gearName, collateralUsdg: rawInt.describe("Collateral in raw USDG (6 dp). New vaults need at least 50 USDG."),
    mintTokens: rawInt.optional().describe("Gear tokens to mint against the collateral, raw 18 dp."),
    vaultId: z.string().regex(/^[1-9]\d{0,30}$/).optional().describe("An existing vault of the owner on the same gear; omit to open a new one."), slippageBps, deadlineSeconds, owner,
  }).strict(),
  execution: true,
  async run(context, args) {
    const agent = requireAgent(context);
    const ownerAddress = ownerOf(context, args.owner);
    const config = await readConfig(context);
    const gear = resolveGear(config, args.gear);
    if (!agent.gears) throw new ToolError("GEAR_READ_FAILED", "Gear settings cannot be read, so the collateral rule cannot be checked.");
    const facts = await agent.gears.read(gear.id);
    if (facts.kind === "ECO" || facts.settled) throw new ToolError("NotBackable", "This gear cannot be backed (negative toll or settled).");
    const collateral = BigInt(args.collateralUsdg);
    const mint = BigInt(args.mintTokens ?? "0");
    const vaultId = BigInt(args.vaultId ?? "0");
    if (vaultId === 0n && collateral < MIN_NEW_VAULT_USDG) throw new ToolError("BELOW_MIN", "A new vault needs at least 50 USDG of collateral.");
    const slippage = BigInt(args.slippageBps ?? 50);
    const ttl = args.deadlineSeconds ?? 300;

    // The ratio and the liquidation price, before anything is sent.
    const one = record(record(await context.api.get(`/v1/gears/${encodeURIComponent(gear.id)}`)).gear);
    const valuePerToken = BigInt(typeof one.valuePerToken === "string" ? one.valuePerToken : "0");
    let totalCollateral = collateral, totalDebtWad = (mint * valuePerToken) / WAD;
    if (vaultId !== 0n) {
      const vault = record(record(await context.api.get(`/v1/vaults/${vaultId}`)).vault);
      if (String(vault.gearId ?? "").toLowerCase() !== gear.id) throw new ToolError("VaultGearMismatch", "That vault is not on this gear.");
      totalCollateral += BigInt(String(vault.collateralUsdg ?? "0"));
      totalDebtWad += BigInt(String(vault.debtValueWad ?? "0"));
    }
    const ratio = ratioBps(totalCollateral, totalDebtWad);
    const required = BigInt(facts.collateralBps);
    const liquidationPrice = totalDebtWad > 0n && typeof one.price === "string" ? liquidationPriceWad(BigInt(one.price), ratio, BigInt(facts.maintenanceBps), Number(one.power)) : null;
    const risk = { collateralRatioBps: ratio.toString(), requiredBps: required.toString(), maintenanceBps: String(facts.maintenanceBps), liquidationPrice: liquidationPrice?.toString() ?? null, collateralUsdg: collateral.toString(), mintTokens: mint.toString() };
    if (mint > 0n && ratio < required) throw new ToolError("COLLATERAL_TOO_LOW", "The collateral is below the gear's required ratio, so nothing was prepared or sent.", { risk });

    let minProceeds = 0n;
    if (mint > 0n) {
      const sellQuote = record(await context.api.get(`/v1/quote?gear=${encodeURIComponent(gear.id)}&side=sell&tokens=${mint}`));
      const suggested = typeof sellQuote.minOutSuggested === "string" ? BigInt(sellQuote.minOutSuggested) : 0n;
      const out = typeof sellQuote.amountOut === "string" ? BigInt(sellQuote.amountOut) : 0n;
      if (suggested === 0n || out === 0n || sellQuote.stale === true) throw new ToolError("NOT_EXECUTABLE", "The mint cannot be priced now, so nothing was prepared or sent.", { quote: sellQuote });
      minProceeds = (out * (10_000n - slippage)) / 10_000n;
    }
    const nowSec = BigInt(Math.floor(context.now() / 1000));
    const plan: BackPlan = { gearId: gear.id, vaultId, collateralUsdg: collateral, mintTokens: mint, minProceedsUsdg: minProceeds, deadline: nowSec + BigInt(ttl) };
    const call = routerCallFromIntent("back", plan, ownerAddress, { gearId: gear.id, markets: gear.markets });
    const router = routerOf(context, config);
    const summary = { gear: gear.symbol, gearId: gear.id, vaultId: vaultId.toString(), risk, display: { collateralUsdg: human(collateral, 6), mintTokens: human(mint, 18), minProceedsUsdg: human(minProceeds, 6) }, minProceedsUsdg: minProceeds.toString(), deadline: plan.deadline.toString() };

    // R6: a buy-only policy never opens a vault. The plan comes back so the owner can see what was refused.
    if (context.mode === "send") {
      const policy = await agent.policy.read(ownerAddress, agent.account.address);
      if (policy && !policy.canBack) throw new ToolError("NOT_SUPPORTED_BY_POLICY", "The owner's policy does not allow backing. Nothing was sent.", { plan: { tx: { to: router, data: encodeRouterCall(call), value: "0" }, ...summary } });
    }
    return finish(context, { call, router, owner: ownerAddress }, summary);
  },
});

const positions = defineTool({
  name: "od_positions",
  description: "Balances of an account per gear (value, cost basis, toll paid, queued sells) and its backer vaults with health. Read only.",
  input: z.object({ owner }).strict(),
  execution: false,
  async run(context, args) {
    const target = ownerOf(context, args.owner);
    const [account, vaults] = await Promise.all([
      context.api.get(`/v1/account/${target}`),
      context.api.get(`/v1/backers/${target}`).catch(() => null),
    ]);
    return { data: { account, vaults }, owner: target };
  },
});

const governor = defineTool({
  name: "od_governor",
  description: "The Governor: equity, exposure per underlying, exit reserve, unhedged amounts, caps used and active pauses. Read only.",
  input: z.object({}).strict(),
  execution: false,
  run: async (context) => ({ data: await context.api.get("/v1/governor") }),
});

const exit = defineTool({
  name: "od_exit",
  description: "The exit reserve: balance against its floor, coverage of open value, the sell queue and which gears can exit now. Read only.",
  input: z.object({}).strict(),
  execution: false,
  run: async (context) => ({ data: await context.api.get("/v1/exit") }),
});

export const READ_TOOLS: readonly ToolDefinition<any>[] = [gears, quote, positions, governor, exit];
export const WRITE_TOOLS: readonly ToolDefinition<any>[] = [buy, sell, back];
export const TOOLS: readonly ToolDefinition<any>[] = [gears, quote, buy, sell, back, positions, governor, exit];
export const TOOL_NAMES = TOOLS.map((t) => t.name);
/** R1: no key means only the read tools and od_quote; a key registers the write tools, which send only in send mode. */
export const toolsFor = (mode: Mode): readonly ToolDefinition<any>[] => (mode === "read_only" ? READ_TOOLS : TOOLS);
