// Agent flows M01 to M04 (todo 22d). The owner sets a policy on the agent router, the agent key trades inside it; every refusal is
// asserted twice: client side (the MCP's own checkPolicy over the router's policy reader) and on chain (decoded revert name).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Abi, type Address, type Hex } from "viem";
import { IODAgentRouterAbi, IODMinterAbi } from "../../../src/abi";
import { chainPolicyReader, checkPolicy, type RouterCall } from "../../../src/mcp/agent";
import { hostedProblem } from "../../../src/mcp/cli";
import { addressOf, FORK_DIR, MCP_URL } from "../lib";
import { marketId } from "../setup";
import {
  GEAR, apiBalance, apiGet, approveMinter, ensureCapital, ensureGear, freshen, fundRole, minterQuote, nowTs, tokenOf, U, usdgOf, v4Quote, warpBy,
  type Ctx, type Flow, type GearInfo, type Row,
} from "./harness";

const router = (ctx: Ctx) => ctx.c.ODAgentRouter!;
const ETH = marketId("ETH");

async function setup(ctx: Ctx, row: Row): Promise<{ g: GearInfo; btc: GearInfo; owner: Address; agent: Address }> {
  await ensureCapital(ctx, row);
  const g = await ensureGear(ctx, row, "ETH", null, GEAR.SPORT);
  const btc = await ensureGear(ctx, row, "BTC", null, GEAR.SPORT);
  const owner = await fundRole(ctx, "agentOwner", 100_000);
  await approveMinter(ctx, row, "agentOwner", ctx.usdg, router(ctx));
  await approveMinter(ctx, row, "agentOwner", g.token, router(ctx));
  await freshen(ctx, ["ETH", "BTC"]);
  return { g, btc, owner, agent: addressOf("agent") };
}
const setPolicy = async (ctx: Ctx, row: Row, label: string, p: { budget: bigint; max: bigint; expiresIn: bigint; canSell?: boolean }) =>
  row.send(label, "agentOwner", {
    address: router(ctx), abi: IODAgentRouterAbi as Abi, functionName: "setPolicy",
    args: [addressOf("agent"), p.budget, p.max, (await nowTs(ctx)) + p.expiresIn, p.canSell ?? false, false, [ETH]],
  });

/** One refusal: client side first, then the router. */
async function refused(ctx: Ctx, row: Row, label: string, who: "agent" | "alice", g: GearInfo, spend: bigint, kind: "buy" | "sell", code: string, markets: Hex[] = [ETH]) {
  const owner = addressOf("agentOwner");
  const now = await nowTs(ctx);
  const call: RouterCall = kind === "buy"
    ? { kind: "buy", gearId: g.id, markets, spendUsdg: spend, args: [owner, g.id, spend, 0n, now + 600n] }
    : { kind: "sell", gearId: g.id, markets, spendUsdg: 0n, args: [owner, g.id, spend, 0n, now + 600n] };
  const reader = chainPolicyReader(ctx.pub as never, router(ctx));
  const policy = await reader.read(owner, who === "agent" ? addressOf("agent") : addressOf("alice"));
  const err = checkPolicy(policy, call, Number(now));
  row.chain(`${label}: client-side refusal`, (err as { code?: string } | null)?.code ?? "(allowed)", code);
  await row.expectRevert(`${label}: router`, who, {
    address: router(ctx), abi: IODAgentRouterAbi as Abi, functionName: kind === "buy" ? "buyFor" : "sellFor", args: call.args as unknown as unknown[],
  }, [code]);
}

const M01: Flow = {
  id: "M01", area: "agents", kind: "success", name: "session key buy within budget: tokens go to the owner, budget shrinks, API shows the balance",
  async run(row, ctx) {
    const { g, owner, agent } = await setup(ctx, row);
    const spent = ((await ctx.pub.readContract({ address: router(ctx), abi: IODAgentRouterAbi, functionName: "policyOf", args: [owner, agent] })) as { spentUsdg: bigint }).spentUsdg;
    await setPolicy(ctx, row, "owner sets policy (budget spent+1000, max 400, 1 day, ETH only)", { budget: spent + U(1000), max: U(400), expiresIn: 86_400n });
    const t0 = await tokenOf(ctx, g.token, owner), u0 = await usdgOf(ctx, owner), a0 = await usdgOf(ctx, agent);
    const q = await minterQuote(ctx, null, g.id, true, true, U(300), owner);
    await row.send("agent buyFor 300 USDG", "agent", { address: router(ctx), abi: IODAgentRouterAbi as Abi, functionName: "buyFor", args: [owner, g.id, U(300), 0n, (await nowTs(ctx)) + 3600n], gas: 3_000_000n });
    const got = (await tokenOf(ctx, g.token, owner)) - t0;
    row.chainWithin("owner received tokens near the quote (accrual second)", got, q.amountOut, q.amountOut / 1_000_000n + 1n);
    row.chain("owner paid exactly 300 USDG", u0 - (await usdgOf(ctx, owner)), U(300));
    row.chain("agent key holds no USDG delta", (await usdgOf(ctx, agent)) - a0, 0n);
    row.chain("remainingBudget 700", await ctx.pub.readContract({ address: router(ctx), abi: IODAgentRouterAbi, functionName: "remainingBudget", args: [owner, agent] }), U(700));
    const api = await apiBalance(owner, (await apiGet<{ gears: { id: string; symbol: string }[] }>("/v1/gears")).gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())!.symbol, await tokenOf(ctx, g.token, owner));
    row.api("API account balance equals chain", api?.balance, await tokenOf(ctx, g.token, owner));
  },
};

const M02: Flow = {
  id: "M02", area: "agents", kind: "expected_failure", name: "agent refused: over per-trade, over budget, sell, wrong gear, no policy, expired, revoked (client side and on chain)",
  async run(row, ctx) {
    const { g, btc, owner } = await setup(ctx, row);
    // spent survives setPolicy (it is the running total), so budgets are relative to what is already spent
    const spent = ((await ctx.pub.readContract({ address: router(ctx), abi: IODAgentRouterAbi, functionName: "policyOf", args: [owner, addressOf("agent")] })) as { spentUsdg: bigint }).spentUsdg;
    row.note(`spent before the row: ${spent}`);
    await setPolicy(ctx, row, "owner resets policy (budget spent+800, max 400)", { budget: spent + U(800), max: U(400), expiresIn: 86_400n });
    await refused(ctx, row, "over the per-trade limit", "agent", g, U(450), "buy", "MaxPerTradeExceeded");
    await row.send("agent buyFor 400 (inside limits)", "agent", { address: router(ctx), abi: IODAgentRouterAbi as Abi, functionName: "buyFor", args: [owner, g.id, U(400), 0n, (await nowTs(ctx)) + 3600n], gas: 3_000_000n });
    await row.send("agent buyFor 400 again", "agent", { address: router(ctx), abi: IODAgentRouterAbi as Abi, functionName: "buyFor", args: [owner, g.id, U(400), 0n, (await nowTs(ctx)) + 3600n], gas: 3_000_000n });
    await refused(ctx, row, "over the remaining budget", "agent", g, U(300), "buy", "BudgetExceeded");
    await refused(ctx, row, "sell without canSell", "agent", g, 10n ** 18n, "sell", "SellNotAllowed");
    await setPolicy(ctx, row, "owner raises budget to 5000", { budget: spent + U(5000), max: U(400), expiresIn: 86_400n });
    await refused(ctx, row, "gear outside the allowed markets", "agent", btc, U(100), "buy", "MarketNotAllowed", [marketId("BTC")]);
    await refused(ctx, row, "an address with no policy", "alice", g, U(100), "buy", "NoPolicy");
    await setPolicy(ctx, row, "owner sets a 5 minute policy", { budget: spent + U(5000), max: U(400), expiresIn: 300n });
    await warpBy(ctx, 330);
    await freshen(ctx, ["ETH", "BTC"]);
    await refused(ctx, row, "expired policy", "agent", g, U(100), "buy", "PolicyExpired");
    await setPolicy(ctx, row, "owner sets a fresh policy", { budget: spent + U(5000), max: U(400), expiresIn: 86_400n });
    await row.send("owner revokes the agent", "agentOwner", { address: router(ctx), abi: IODAgentRouterAbi as Abi, functionName: "revoke", args: [addressOf("agent")] });
    await refused(ctx, row, "revoked agent", "agent", g, U(100), "buy", "PolicyIsRevoked");
  },
};

const mcpToken = () => readFileSync(join(FORK_DIR, "env", "mcp.env"), "utf8").split("\n").find((l) => l.startsWith("MCP_HTTP_TOKEN="))?.slice("MCP_HTTP_TOKEN=".length) ?? "";
async function rpc(method: string, params?: unknown, token = mcpToken()): Promise<{ result?: any; error?: any }> {
  const r = await fetch(`${MCP_URL}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await r.text();
  const body = text.startsWith("event:") || text.includes("\ndata:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(body);
}

const M03: Flow = {
  id: "M03", area: "agents", kind: "success", name: "MCP od_quote equals the API quote equals the hook (V4Quoter) and the minter, buy and sell",
  async run(row, ctx) {
    const { g } = await setup(ctx, row);
    const who = addressOf("alice");
    await freshen(ctx, ["ETH", "BTC"]);
    const sym = (await apiGet<{ gears: { id: string; symbol: string }[] }>("/v1/gears")).gears.find((x) => x.id.toLowerCase() === g.id.toLowerCase())!.symbol;
    const amount = U(1000);
    const mcp = await rpc("tools/call", { name: "od_quote", arguments: { gear: sym, side: "buy", usdg: amount.toString() } });
    const data = mcp.result?.structuredContent?.data ?? {};
    row.chainTrue("MCP od_quote answered", !mcp.error && mcp.result?.isError === false, JSON.stringify(mcp).slice(0, 300));
    const api = await apiGet<Record<string, unknown>>(`/v1/quote?gear=${g.id}&side=buy&usdg=${amount}&account=${who}`);
    // the three read at the same block only while no block lands between them: compare to a tolerance of 0.01% and report the three
    const hook = await v4Quote(ctx, null, g.id, true, amount);
    const mq = (await minterQuote(ctx, null, g.id, true, true, amount, who)).amountOut;
    const out = (v: unknown) => BigInt(String(v ?? "0"));
    const mcpOut = out(data.tokensOut ?? data.amountOut);
    row.note(`buy 1000 USDG: hook ${hook} minter ${mq} api ${api.tokensOut} mcp ${mcpOut}`);
    const tol = hook / 10_000n + 1n;
    row.apiWithin("API quote tokensOut vs V4Quoter", out(api.tokensOut), hook, tol);
    row.apiWithin("MCP od_quote tokensOut vs V4Quoter", mcpOut, hook, tol);
    row.apiWithin("MCP vs API quote", mcpOut, out(api.tokensOut), tol);
    row.chainWithin("minter.quote vs V4Quoter", mq, hook, tol);
    row.api("MCP and API agree on buyable", data.buyable, api.buyable);
    // a sell quote through the MCP equals the API's
    const tokens = (await tokenOf(ctx, g.token, addressOf("agentOwner"))) / 2n;
    if (tokens > 0n) {
      const msell = await rpc("tools/call", { name: "od_quote", arguments: { gear: sym, side: "sell", tokens: tokens.toString() } });
      const asell = await apiGet<Record<string, unknown>>(`/v1/quote?gear=${g.id}&side=sell&tokens=${tokens}&account=${addressOf("agentOwner")}`);
      const md = msell.result?.structuredContent?.data ?? {};
      row.apiWithin("MCP sell usdgOut vs API", out(md.usdgOut ?? md.amountOut), out(asell.usdgOut ?? asell.amountOut), out(asell.usdgOut ?? asell.amountOut) / 10_000n + 1n);
    }
  },
};

const M04: Flow = {
  id: "M04", area: "agents", kind: "expected_failure", name: "hosted MCP is read only: five read tools, no write tool, unknown write calls refused, no token refused, key refused at startup",
  async run(row, ctx) {
    void ctx;
    const list = await rpc("tools/list");
    const tools = list.result?.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    row.api("tool names", tools.map((t) => t.name).sort().join(","), "od_exit,od_gears,od_governor,od_positions,od_quote");
    row.api("every tool is readOnlyHint", tools.every((t) => t.annotations?.readOnlyHint === true), true);
    for (const name of ["od_buy_gear", "od_sell_gear", "od_back_gear"]) {
      const r = await rpc("tools/call", { name, arguments: { gear: "ETH-SPORT", usdg: "1" } });
      row.api(`${name} is refused`, Boolean(r.error) || r.result?.isError === true, true);
    }
    const noAuth = await fetch(`${MCP_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    row.api("no bearer token gets 401", noAuth.status, 401);
    row.api("hosted server refuses an agent key at startup", typeof hostedProblem({ AGENT_KEY: "placeholder" }), "string");
    row.api("hosted server starts with no key", hostedProblem({}), undefined);
    void getAddress; void IODMinterAbi;
  },
};

export const flows: Flow[] = [M01, M02, M03, M04];
