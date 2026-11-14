import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IODAgentRouterAbi } from "../abi";
import { MockRevert } from "../testing/mock-router";
import { checkPolicy, createAgentRuntime, encodeRouterCall, envPolicyReader, routerCallFromIntent, sendRouterCall, type RouterCall } from "./agent";
import { ToolError } from "./api-client";
import { loadMcpSettings } from "./config";
import { buildMcp } from "./index";
import { fakeApi, idOf, MARKET_NVDA, MARKET_TSLA, MINTER, NOW_MS, NOW_S, NVDA_SPORT, OWNER, REGISTRY, rig, ROUTER, SPORT, addr, type RigOptions } from "./test-support";
import { TOOLS } from "./tools";

const tool = (name: string): any => TOOLS.find((t) => t.name === name)!;
const buyIntent = async (usdg: string, over: Record<string, unknown> = {}) => (await fakeApi().post("/v1/intent/buy", { gear: SPORT, account: OWNER, usdg, minOut: "1990000000000000000", recipient: OWNER, deadlineSec: 300, ...over })) as any;
const buyCall = async (usdg: string, gear: Hex = SPORT, markets: Hex[] = [MARKET_TSLA]) => routerCallFromIntent("buy", await buyIntent(usdg, { gear }), OWNER, { gearId: gear, minter: MINTER, markets });

describe("policy: the chain is the authority", () => {
  test("chain_policy_wins_over_env_mirror", async () => {
    const r = rig({ policy: { budgetUsdg: 10_000_000n, maxPerTradeUsdg: 10_000_000n } });
    // The environment offers a far bigger policy, but AGENT_POLICY_FROM_ENV is off: it is not even loaded.
    const env = { AGENT_KEY: r.key, AGENT_OWNER: OWNER, AGENT_POLICY: JSON.stringify({ owner: OWNER, budgetUsdg: "9999999999", maxPerTradeUsdg: "9999999999", expiresAt: NOW_S + 9999, markets: [MARKET_TSLA], canSell: true }) };
    const settings = loadMcpSettings(env);
    expect(settings.policy).toBeUndefined();
    const { server, mode } = await buildMcp(settings, { api: fakeApi(), chain: r.router.reader() as never, executor: { send: async ({ data }) => { r.router.execute(r.agent.account.address, data); return { txHash: idOf("t") }; } }, now: () => NOW_MS });
    expect(mode).toBe("send");
    const ok = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "od_buy_gear", arguments: { gear: "TSLA-SPORT", usdg: "5000000" } } }, "k") as any;
    expect(ok.result.isError).toBe(false);
    const over = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "od_buy_gear", arguments: { gear: "TSLA-SPORT", usdg: "20000000" } } }, "k") as any;
    expect(over.result.isError).toBe(true);
    expect(over.result.structuredContent.error).toBe("MaxPerTradeExceeded"); // the chain's 10 USDG limit, not the env's
    // and the env mirror, even when asked for, counts only in development
    expect(loadMcpSettings({ ...env, AGENT_POLICY_FROM_ENV: "1" }).policy?.budgetUsdg).toBe("9999999999");
  });

  test("env_policy_refused_in_production", () => {
    expect(() => loadMcpSettings({ NODE_ENV: "production", AGENT_POLICY_FROM_ENV: "1", AGENT_POLICY: "{}" })).toThrow(/AGENT_POLICY_FROM_ENV is refused/);
    expect(() => loadMcpSettings({ NODE_ENV: "production", AGENT_POLICY_FROM_ENV: "true" })).toThrow(/refused/);
  });
});

describe("R3 every limit is refused client side with the contract's error name, and the router mock reverts the same", () => {
  const cases: Array<{ name: string; rig: RigOptions; call: () => Promise<RouterCall>; revoke?: boolean }> = [
    { name: "MaxPerTradeExceeded", rig: { policy: { maxPerTradeUsdg: 1_000_000n } }, call: () => buyCall("5000000") },
    { name: "BudgetExceeded", rig: { policy: { budgetUsdg: 3_000_000n } }, call: () => buyCall("5000000") },
    { name: "MarketNotAllowed", rig: {}, call: () => buyCall("1000000", NVDA_SPORT, [MARKET_NVDA]) },
    { name: "SellNotAllowed", rig: { policy: { canSell: false } }, call: async () => routerCallFromIntent("sell", (await fakeApi().post("/v1/intent/sell", { gear: SPORT, account: OWNER, tokens: "1000", minOut: "1", recipient: OWNER })) as any, OWNER, { gearId: SPORT, markets: [MARKET_TSLA] }) },
    { name: "BackNotAllowed", rig: { policy: { canBack: false } }, call: async () => routerCallFromIntent("back", { gearId: SPORT, vaultId: 0n, collateralUsdg: 60_000_000n, mintTokens: 0n, minProceedsUsdg: 0n, deadline: BigInt(NOW_S + 300) }, OWNER, { gearId: SPORT, markets: [MARKET_TSLA] }) },
    { name: "PolicyExpired", rig: { policy: { expiresAt: NOW_S - 10 } }, call: () => buyCall("1000000") },
    { name: "PolicyIsRevoked", rig: {}, revoke: true, call: () => buyCall("1000000") },
    { name: "NoPolicy", rig: { policy: null }, call: () => buyCall("1000000") },
  ];
  test("each_limit_refused_client_side_and_reverts_on_chain_mock", async () => {
    for (const c of cases) {
      const calls = await c.call();
      const client = rig(c.rig);
      if (c.revoke) client.router.revoke(OWNER, client.agent.account.address);
      const refusal = await sendRouterCall(client.agent, ROUTER, calls, OWNER).catch((e: any) => e);
      expect(refusal).toBeInstanceOf(ToolError);
      expect(refusal.code).toBe(c.name);
      expect(client.sent.length).toBe(0);
      // The same calldata, sent without the client-side check, reverts on the router mock with the same error.
      const chain = rig({ ...c.rig, clientSideChecks: false });
      if (c.revoke) chain.router.revoke(OWNER, chain.agent.account.address);
      const reverted = await sendRouterCall(chain.agent, ROUTER, calls, OWNER).catch((e: any) => e);
      expect(reverted).toBeInstanceOf(MockRevert);
      expect(reverted.errorName).toBe(c.name);
    }
  });
});

describe("R4 quote equals execution through the agent path", () => {
  test("intent_decodes_to_quoted_call", async () => {
    const intent = await buyIntent("5000000");
    const call = routerCallFromIntent("buy", intent, OWNER, { gearId: SPORT, minter: MINTER, amount: 5_000_000n, minOut: 1_990_000_000_000_000_000n, deadline: BigInt(NOW_S + 300), markets: [MARKET_TSLA] });
    const decoded = decodeFunctionData({ abi: IODAgentRouterAbi, data: encodeRouterCall(call) });
    expect(decoded.functionName).toBe("buyFor");
    expect(decoded.args).toEqual([OWNER, SPORT, 5_000_000n, 1_990_000_000_000_000_000n, BigInt(NOW_S + 300)]);
    // through the tool in prepare mode: the calldata it hands back is that same call
    const r = rig({ mode: "prepare" });
    const out = await tool("od_buy_gear").run(r.ctx, { gear: "TSLA-SPORT", usdg: "5000000", slippageBps: 50 }) as any;
    expect(out.status).toBe("prepared");
    expect(out.tx.to).toBe(ROUTER);
    const back = decodeFunctionData({ abi: IODAgentRouterAbi, data: out.tx.data });
    expect(back.args?.slice(0, 3)).toEqual([OWNER, SPORT, 5_000_000n]);
    expect(r.sent.length).toBe(0); // prepare never sends
  });

  test("tampered_intent_refused", async () => {
    const good = await buyIntent("5000000");
    const expect0 = { gearId: SPORT, minter: MINTER, amount: 5_000_000n, markets: [MARKET_TSLA] };
    const refuse = (intent: unknown, over: object = {}) => expect(() => routerCallFromIntent("buy", intent as any, OWNER, { ...expect0, ...over })).toThrow(expect.objectContaining({ code: "BAD_INTENT" }));
    refuse(await buyIntent("5000000", { gear: NVDA_SPORT })); // a different gear
    refuse(await buyIntent("5000000", { recipient: addr("thief") })); // a recipient that is not the owner
    refuse({ ...good, tx: { ...good.tx, to: addr("elsewhere") } }); // calldata to another contract
    refuse(await buyIntent("6000000")); // a different amount
    refuse({ ...good, kind: "sell" }); // the wrong action
    refuse({ ...good, tx: { ...good.tx, data: "0xdeadbeef" } }); // not decodable
    refuse(good, { deadlineWithin: [1n, 2n] }); // a deadline outside the window
    // and through the tool: an API that tampers is refused before anything is signed
    const r = rig({ api: { tamper: (_k, _d, body) => ({ to: addr("elsewhere"), data: undefined as never }) } });
    const err: any = await tool("od_buy_gear").run(r.ctx, { gear: "TSLA-SPORT", usdg: "5000000" }).catch((e: any) => e);
    expect(err.code).toBe("BAD_INTENT");
    expect(r.sent.length).toBe(0);
  });
});

describe("R5 spend tracking", () => {
  test("concurrent_buys_respect_budget", async () => {
    const r = rig({ policy: { budgetUsdg: 1_500_000n }, sendDelayMs: 25 });
    const call = await buyCall("1000000");
    const results = await Promise.all([sendRouterCall(r.agent, ROUTER, call, OWNER).catch((e: any) => e), sendRouterCall(r.agent, ROUTER, call, OWNER).catch((e: any) => e)]);
    expect(results.filter((x) => x.txHash).length).toBe(1);
    const refused = results.find((x) => !x.txHash);
    expect(refused).toBeInstanceOf(ToolError); // client side, thanks to the per-owner mutex: never a doomed transaction
    expect(refused.code).toBe("BudgetExceeded");
    expect(r.sent.length).toBe(1);
    expect(r.router.policies.get(`${OWNER.toLowerCase()}:${r.agent.account.address.toLowerCase()}`)!.spentUsdg).toBeLessThanOrEqual(1_500_000n);
  });

  test("failed_send_does_not_spend_mirror", async () => {
    const key = generatePrivateKey();
    const mirror = { owner: OWNER, budgetUsdg: "10000000", spentUsdg: "0", maxPerTradeUsdg: "5000000", expiresAt: NOW_S + 3600, canSell: false, canBack: false, revoked: false, markets: [MARKET_TSLA] };
    const reader = envPolicyReader(mirror, privateKeyToAccount(key).address);
    let fail = true;
    const agent = createAgentRuntime({ key, owner: OWNER, router: ROUTER, policy: reader, executor: () => ({ send: async () => { if (fail) throw new ToolError("TX_REVERTED", "x"); return { txHash: idOf("ok") }; } }), now: () => NOW_MS });
    const call = await buyCall("4000000");
    await expect(sendRouterCall(agent, ROUTER, call, OWNER)).rejects.toThrow();
    expect((await reader.read(OWNER, agent.account.address))!.spentUsdg).toBe(0n);
    fail = false;
    await sendRouterCall(agent, ROUTER, call, OWNER);
    expect((await reader.read(OWNER, agent.account.address))!.spentUsdg).toBe(4_000_000n);
    // the mirror now refuses a second one that would pass the per-trade limit but not the remaining budget
    await sendRouterCall(agent, ROUTER, call, OWNER);
    await expect(sendRouterCall(agent, ROUTER, call, OWNER)).rejects.toMatchObject({ code: "BudgetExceeded" });
  });
});

describe("R11 the key never leaves", () => {
  test("key_never_in_outputs", async () => {
    const outputs: string[] = [];
    for (const mode of ["send", "prepare"] as const) {
      const r = rig({ mode, policy: { canSell: true, canBack: true } });
      const args: Record<string, object> = {
        od_gears: {}, od_quote: { gear: "TSLA-SPORT", side: "buy", usdg: "1000000" }, od_buy_gear: { gear: "TSLA-SPORT", usdg: "1000000" }, od_sell_gear: { gear: "TSLA-SPORT", tokens: "1000" },
        od_back: { gear: "TSLA-RACE", collateralUsdg: "60000000", mintTokens: "100000000000000000" }, od_positions: {}, od_governor: {}, od_exit: {},
      };
      for (const t of TOOLS) outputs.push(JSON.stringify(await t.run(r.ctx, args[t.name]!).catch((e) => ({ name: e.name, code: e.code, message: e.message, detail: e.detail }))));
      // an unexpected failure that carries the key in its message is reduced to a static error by the server
      const { createMcpServer } = await import("./server");
      const { createKeyedLimiter } = await import("./rate-limit");
      const leaky = { ...r.ctx, api: { get: async () => { throw new Error(`boom ${r.key} ${r.key.slice(2)}`); }, post: async () => { throw new Error(r.key); } } };
      const server = createMcpServer({ context: leaky, limiter: createKeyedLimiter({ limit: 0, windowMs: 1 }), tools: TOOLS });
      outputs.push(JSON.stringify(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "od_governor", arguments: {} } }, "k")));
      for (const o of outputs) { expect(o).not.toContain(r.key); expect(o).not.toContain(r.key.slice(2)); }
    }
    expect(outputs.length).toBeGreaterThan(10);
  });
});
void REGISTRY; void checkPolicy;
