import { describe, expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import { resolveMode } from "./agent";
import { loadMcpSettings } from "./config";
import { buildMcp, toolsFor } from "./index";
import { fakeApi, idOf, NOW_MS, NOW_S, OWNER, rig, MARKET_TSLA } from "./test-support";

const names = (server: { listing: Array<{ name: string }> }) => server.listing.map((t) => t.name).sort();
const READ = ["od_exit", "od_gears", "od_governor", "od_positions", "od_quote"];
const ALL = [...READ, "od_back", "od_buy_gear", "od_sell_gear"].sort();

describe("R1 modes", () => {
  test("tool_list_per_mode", async () => {
    const executor = { send: async () => ({ txHash: idOf("x") }) };
    // no key: only the read tools and od_quote, whatever was asked
    for (const MCP_MODE of [undefined, "send", "prepare"]) {
      const s = loadMcpSettings({ OD_API_URL: "http://127.0.0.1:1", ...(MCP_MODE ? { MCP_MODE } : {}) });
      const built = await buildMcp(s, { api: fakeApi() });
      expect(built.mode).toBe("read_only");
      expect(names(built.server)).toEqual(READ);
    }
    // a key with an unreadable policy: prepare, write tools registered but they never send
    const r = rig();
    const key = generatePrivateKey();
    const unreadable = { readContract: async () => { throw new Error("rpc down"); } };
    const prepared = await buildMcp(loadMcpSettings({ AGENT_KEY: key, AGENT_OWNER: OWNER }), { api: fakeApi(), chain: unreadable as never, executor, now: () => NOW_MS });
    expect(prepared.mode).toBe("prepare");
    expect(names(prepared.server)).toEqual(ALL);
    // a key with a live policy: send
    const sending = await buildMcp(loadMcpSettings({ AGENT_KEY: r.key, AGENT_OWNER: OWNER }), { api: fakeApi(), chain: r.router.reader() as never, executor, now: () => NOW_MS });
    expect(sending.mode).toBe("send");
    expect(names(sending.server)).toEqual(ALL);
    // a key, a live policy, but MCP_MODE=prepare or read_only caps it
    expect((await buildMcp(loadMcpSettings({ AGENT_KEY: r.key, AGENT_OWNER: OWNER, MCP_MODE: "prepare" }), { api: fakeApi(), chain: r.router.reader() as never, now: () => NOW_MS })).mode).toBe("prepare");
    const forcedReadOnly = await buildMcp(loadMcpSettings({ AGENT_KEY: r.key, AGENT_OWNER: OWNER, MCP_MODE: "read_only" }), { api: fakeApi(), chain: r.router.reader() as never, now: () => NOW_MS });
    expect(forcedReadOnly.mode).toBe("read_only");
    expect(names(forcedReadOnly.server)).toEqual(READ);
    expect(toolsFor("read_only").map((t) => t.name).sort()).toEqual(READ);
  });

  test("mode falls to prepare when the policy is expired, revoked or missing", async () => {
    for (const setup of ["expired", "revoked", "missing"] as const) {
      const r = rig({ policy: setup === "missing" ? null : setup === "expired" ? { expiresAt: NOW_S - 1 } : {} });
      if (setup === "revoked") r.router.revoke(OWNER, r.agent.account.address);
      expect(await resolveMode(r.agent, "send", OWNER)).toBe("prepare");
    }
    expect(await resolveMode(rig().agent, "send", undefined)).toBe("prepare");
    expect(await resolveMode(rig().agent, "send", OWNER)).toBe("send");
    expect(await resolveMode(undefined, "send", OWNER)).toBe("read_only");
    void MARKET_TSLA;
  });

  test("an unregistered write tool is an unknown tool", async () => {
    const built = await buildMcp(loadMcpSettings({}), { api: fakeApi() });
    const res = await built.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "od_buy_gear", arguments: { gear: "TSLA-SPORT", usdg: "1" } } }, "k") as any;
    expect(res.error.code).toBe(-32602);
  });
});

describe("protocol", () => {
  test("initialize, list, call, bad arguments, unknown method", async () => {
    const { server } = await buildMcp(loadMcpSettings({}), { api: fakeApi() });
    const call = (message: unknown) => server.handle(message, "k") as Promise<any>;
    expect((await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name).toBe("overdrive");
    expect(await call({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const listed = (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools;
    expect(listed.length).toBe(5);
    expect(listed.every((t: any) => t.annotations.readOnlyHint === true)).toBe(true);
    const ok = (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "od_quote", arguments: { gear: "TSLA-SPORT", side: "buy", usdg: "1000000" } } })).result;
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent.data.buyable).toBe(true);
    const bad = (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "od_quote", arguments: { gear: "TSLA-SPORT", side: "buy", usdg: "1000000", extra: 1 } } })).result;
    expect(bad.structuredContent.error).toBe("BAD_ARGUMENTS");
    expect((await call({ jsonrpc: "2.0", id: 5, method: "nope" })).error.code).toBe(-32601);
  });
});
