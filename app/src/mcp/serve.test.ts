import { describe, expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import { agentKeyConfigured, cliEnvironment, hostedProblem } from "./cli";
import { loadMcpSettings } from "./config";
import { createMcpHttpApp, httpStartupProblem, MAX_BODY_BYTES } from "./http";
import { buildMcp } from "./index";
import { serveHttp } from "./serve";
import { fakeApi } from "./test-support";

const rpc = (method: string, params?: unknown, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const post = (app: { request: (...a: any[]) => Response | Promise<Response> }, body: string, headers: Record<string, string> = {}) =>
  app.request("/mcp", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("R1 hosted server", () => {
  test("hosted_server_has_no_key_and_no_write_tools", async () => {
    const key = generatePrivateKey();
    // the hosted entry point refuses any key variable
    expect(hostedProblem({ AGENT_KEY: key })).toMatch(/holds no key/);
    expect(hostedProblem({ AGENT_KEYSTORE: "/x" })).toMatch(/holds no key/);
    expect(hostedProblem({ AGENT_PRIVATE_KEY: key })).toMatch(/holds no key/);
    expect(hostedProblem({})).toBeUndefined();
    expect(agentKeyConfigured({ AGENT_KEYSTORE_PASSWORD_FILE: "/p" })).toBe(true);
    // what it serves: read tools only, over HTTP, no write tool callable
    const settings = loadMcpSettings({});
    const { server, agent, mode } = await buildMcp(settings, { api: fakeApi() });
    expect(agent).toBeUndefined();
    expect(mode).toBe("read_only");
    const app = createMcpHttpApp(server, { token: undefined, allowedOrigins: [], readOnly: true, peerAddress: () => "203.0.113.5" });
    const listed = await (await post(app, rpc("tools/list"))).json() as any;
    const names = listed.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["od_gears", "od_quote", "od_positions", "od_governor", "od_exit"]);
    for (const w of ["od_buy_gear", "od_sell_gear", "od_back"]) {
      const res = await (await post(app, rpc("tools/call", { name: w, arguments: {} }))).json() as any;
      expect(res.error).toBeTruthy();
    }
    expect(JSON.stringify(listed)).not.toContain(key);
  });

  test("transport: size cap, batch cap, origins, landing page", async () => {
    const { server } = await buildMcp(loadMcpSettings({}), { api: fakeApi() });
    const app = createMcpHttpApp(server, { token: undefined, allowedOrigins: [], readOnly: true, peerAddress: () => "203.0.113.5" });
    expect((await post(app, "x".repeat(MAX_BODY_BYTES + 10))).status).toBe(413);
    expect((await post(app, "{")).status).toBe(400);
    expect((await post(app, JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))))).status).toBe(400);
    expect((await post(app, rpc("ping"), { origin: "https://anywhere.example" })).status).toBe(200); // hosted read-only: open CORS
    const page = await app.request("/", { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("this address is for AI agents");
    expect((await app.request("/mcp", { method: "GET", headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect(httpStartupProblem({ httpToken: undefined, allowedOrigins: ["*"] }, false)).toBeUndefined();
    expect(httpStartupProblem({ httpToken: undefined, allowedOrigins: [] }, true)).toMatch(/MCP_HTTP_TOKEN/);
  });

  test("the node listener serves the same app", async () => {
    const { server } = await buildMcp(loadMcpSettings({}), { api: fakeApi() });
    const app = createMcpHttpApp(server, { token: undefined, allowedOrigins: [], readOnly: true });
    const listener = await serveHttp({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, idleTimeoutSeconds: 5, runtime: "node" });
    try {
      const res = await fetch(`http://127.0.0.1:${listener.port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: rpc("ping") });
      expect(((await res.json()) as any).result).toEqual({});
    } finally { listener.stop(); }
  });

  test("OD_API_URL defaults only when unset or blank", () => {
    const options = { defaultApiUrl: "http://127.0.0.1:3100" };
    expect(cliEnvironment({}, options).OD_API_URL).toBe("http://127.0.0.1:3100");
    expect(cliEnvironment({ OD_API_URL: " " }, options).OD_API_URL).toBe("http://127.0.0.1:3100");
    expect(cliEnvironment({ OD_API_URL: "http://api.example" }, options).OD_API_URL).toBe("http://api.example");
  });
});
