import { describe, expect, test } from "bun:test";
import { ipLiteral, resolveClientAddress } from "./client-address";
import { loadMcpSettings } from "./config";
import { buildMcp } from "./index";
import { createKeyedLimiter } from "./rate-limit";
import { createMcpServer, MAX_RESULT_BYTES } from "./server";
import { fakeApi } from "./test-support";
import { READ_TOOLS } from "./tools";

describe("R9 limits", () => {
  test("per_client_limit_and_caps", async () => {
    // 60 a minute per client, counted on its own, then the window moves
    let t = 0;
    const limiter = createKeyedLimiter({ limit: 60, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 60; i += 1) expect(limiter.take("a").ok).toBe(true);
    const over = limiter.take("a");
    expect(over.ok).toBe(false);
    expect(over.ok ? 0 : over.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.take("b").ok).toBe(true); // another client is not affected
    t = 61_000;
    expect(limiter.take("a").ok).toBe(true);

    // through the server: the 61st call in the window is RATE_LIMITED
    const { server } = await buildMcp(loadMcpSettings({ MCP_RATE_LIMIT_PER_MINUTE: "2" }), { api: fakeApi(), now: () => 0 });
    const call = () => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "od_exit", arguments: {} } }, "client-1") as Promise<any>;
    await call(); await call();
    expect((await call()).result.structuredContent.error).toBe("RATE_LIMITED");

    // result size cap: never silent
    const big = fakeApi({ routes: { "/v1/exit": { rows: "x".repeat(MAX_RESULT_BYTES + 5_000) } } });
    const s = createMcpServer({ context: { api: big, agent: undefined, mode: "read_only", defaultOwner: undefined, router: undefined, pin: undefined, now: Date.now }, limiter: createKeyedLimiter({ limit: 0, windowMs: 1 }), tools: READ_TOOLS });
    const capped = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "od_exit", arguments: {} } }, "k") as any).result.structuredContent;
    expect(capped.truncated).toBe(true);
    expect(capped.originalBytes).toBeGreaterThan(MAX_RESULT_BYTES);
    expect(capped.note).toMatch(/cut/);

    // per-tool timeout
    const slow = { get: () => new Promise<never>(() => {}), post: async () => ({}) };
    const timed = createMcpServer({ context: { api: slow, agent: undefined, mode: "read_only", defaultOwner: undefined, router: undefined, pin: undefined, now: Date.now }, limiter: createKeyedLimiter({ limit: 0, windowMs: 1 }), tools: READ_TOOLS, toolTimeoutMs: 30 });
    expect(((await timed.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "od_exit", arguments: {} } }, "k")) as any).result.structuredContent.error).toBe("TOOL_TIMEOUT");
  });

  test("caller address comes from the proxy header only for a trusted peer", () => {
    const o = { header: "x-forwarded-for", trustedProxies: ["loopback"] };
    expect(resolveClientAddress("127.0.0.1", "203.0.113.9, 198.51.100.4", o)).toBe("198.51.100.4");
    expect(resolveClientAddress("203.0.113.5", "10.0.0.1", o)).toBe("203.0.113.5");
    expect(resolveClientAddress("127.0.0.1", "not-an-ip", o)).toBe("127.0.0.1");
    expect(ipLiteral("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
});
