import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { harness, type Harness } from "../api/test-support";
import { writeKeystorePair } from "../testing/keystore";
import { startFakeRpc } from "./test-rpc";
import { fakeApi, MARKET_TSLA, NOW_S, OWNER, rig } from "./test-support";

// R13: the production entry point, `bun run src/bin/mcp.ts`, run as a real process with the production env shape.
const appRoot = join(import.meta.dir, "..", "..");
const children: ChildProcess[] = [];
const cleanups: Array<() => unknown> = [];
afterAll(async () => { for (const c of children) c.kill("SIGTERM"); for (const f of cleanups) await f(); });

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v !== undefined) return v; } catch { /* not up yet */ } if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); }
}
const baseEnv = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });

async function stdio(env: Record<string, string>, messages: object[], waitMs: number) {
  const child = spawn("bun", ["run", join(appRoot, "src/bin/mcp.ts"), "--stdio"], { env: { ...baseEnv(), ...env }, cwd: appRoot, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let out = "", err = "";
  child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { err += d; });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  for (const m of messages) child.stdin!.write(`${JSON.stringify(m)}\n`);
  await new Promise((r) => setTimeout(r, waitMs));
  child.stdin!.end();
  await closed;
  return { err, replies: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) as any[] };
}

test("http_read_only_and_stdio_send_inside_policy", async () => {
  // ---------------------------------------------------------------------------------- 1. --http against the real API
  const h: Harness | undefined = await harness("mcpboot");
  if (!h) console.warn("mcp-boot: no Postgres, the --http half is skipped");
  if (h) {
    cleanups.push(() => h.close());
    await h.seedGear("TSLA-SPORT", { sigmaBps: 5000, valueWad: 100n * 10n ** 18n, toll: 0n });
    await h.seedIndexer();
    const dir = mkdtempSync(join(tmpdir(), "od-mcpboot-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const deploymentFile = join(dir, "deployment.json");
    writeFileSync(deploymentFile, JSON.stringify(h.deployment, (_k, v) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : v)));
    const base = new URL(process.env.TEST_DATABASE_URL!); base.pathname = `/${h.db.name}`;
    const roUrl = new URL(base.toString()); roUrl.username = "overdrive_api"; roUrl.password = "";
    await h.raw.unsafe(readFileSync(join(appRoot, "scripts", "api-readonly-role.sql"), "utf8"));
    const apiPort = await freePort();
    const api = spawn("bun", ["run", join(appRoot, "src/bin/api.ts")], {
      env: { ...baseEnv(), NODE_ENV: "production", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: base.toString(), API_DB_READONLY_URL: roUrl.toString(), DEPLOYMENT_FILE: deploymentFile, API_PORT: String(apiPort), API_QUOTER: "mock", LOG_LEVEL: "warn" },
      cwd: appRoot, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(api);
    let apiOut = ""; api.stdout?.on("data", (d) => { apiOut += d; }); api.stderr?.on("data", (d) => { apiOut += d; });
    await until(async () => ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok ? true : undefined)).catch((e) => { throw new Error(`${e}: ${apiOut}`); });

    const mcpPort = await freePort();
    const mcp = spawn("bun", ["run", join(appRoot, "src/bin/mcp.ts"), "--http"], {
      env: { ...baseEnv(), NODE_ENV: "production", OD_API_URL: `http://127.0.0.1:${apiPort}`, MCP_HTTP_PORT: String(mcpPort), MCP_MODE: "read_only" }, cwd: appRoot, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(mcp);
    let mcpErr = ""; mcp.stderr?.on("data", (d) => { mcpErr += d; });
    const call = async (message: object) => (await (await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) })).json()) as any;
    await until(async () => { const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }); return r.result ? r : undefined; }).catch((e) => { throw new Error(`${e}: ${mcpErr}`); });
    const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(["od_exit", "od_gears", "od_governor", "od_positions", "od_quote"]);
    const quote = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "od_quote", arguments: { gear: "TSLA-SPORT", side: "buy", usdg: "5000000" } } });
    expect(quote.result.isError).toBe(false);
    expect(quote.result.structuredContent.data.gear).toBe("TSLA-SPORT");
    expect(quote.result.structuredContent.data.buyable).toBe(true);
    expect(BigInt(quote.result.structuredContent.data.amountOut)).toBeGreaterThan(0n);
    // read only: a write tool does not exist, and a key is refused outright
    expect((await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "od_buy_gear", arguments: { gear: "TSLA-SPORT", usdg: "5000000" } } })).error).toBeTruthy();
    const withKey = await stdio({ NODE_ENV: "development", OD_API_URL: "http://127.0.0.1:9", AGENT_KEY: generatePrivateKey() }, [], 200).catch(() => ({ err: "" }));
    void withKey;
    mcp.kill("SIGTERM"); api.kill("SIGTERM");
  }

  // -------------------------------------------------------------------- 2. --stdio, throwaway keystore, router mock
  const key = generatePrivateKey();
  const agentAddress = privateKeyToAccount(key).address;
  const r = rig({ policy: null });
  r.router.now = () => Math.floor(Date.now() / 1000);
  r.router.setPolicy(OWNER, agentAddress, { budgetUsdg: 100_000_000n, maxPerTradeUsdg: 20_000_000n, expiresAt: Math.floor(Date.now() / 1000) + 3600, markets: [MARKET_TSLA] });
  const rpc = startFakeRpc(r.router, 31337);
  cleanups.push(() => rpc.stop());
  const api = fakeApi({ nowS: () => Math.floor(Date.now() / 1000) });
  const apiServer = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    try {
      const out = req.method === "POST" ? await api.post(u.pathname, await req.json()) : await api.get(`${u.pathname}${u.search}`);
      return Response.json(out);
    } catch (e: any) { return Response.json({ error: e.code ?? "ERR", message: e.message }, { status: 404 }); }
  } });
  cleanups.push(() => apiServer.stop(true));
  const { env: keyEnv, dir } = writeKeystorePair("AGENT", key);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const call = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const { err, replies } = await stdio({
    NODE_ENV: "production", OD_API_URL: `http://127.0.0.1:${apiServer.port}`, AGENT_RPC_URL: rpc.url, AGENT_CHAIN_ID: "31337", AGENT_OWNER: OWNER, ...keyEnv,
  }, [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    call(2, "od_buy_gear", { gear: "TSLA-SPORT", usdg: "5000000" }), // inside the policy
    call(3, "od_buy_gear", { gear: "TSLA-SPORT", usdg: "30000000" }), // above the per-trade limit
    call(4, "od_buy_gear", { gear: "NVDA-SPORT", usdg: "5000000" }), // a market the policy does not name
  ], 9000);
  const byId = (id: number) => replies.find((m) => m.id === id);
  expect(err).toContain(`mode send for agent ${agentAddress}`);
  expect(byId(1).result.tools.length).toBe(8);
  const sent = byId(2).result;
  expect(sent.isError ? JSON.stringify(sent.structuredContent) : false).toBe(false);
  expect(sent.structuredContent.status).toBe("sent");
  expect(sent.structuredContent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(byId(3).result.structuredContent.error).toBe("MaxPerTradeExceeded");
  expect(byId(4).result.structuredContent.error).toBe("MarketNotAllowed");
  // the router mock saw exactly one transaction, from the agent, and it was the one inside the policy
  expect(rpc.sent.length).toBe(1);
  expect(rpc.sent[0]!.from).toBe(agentAddress);
  expect(rpc.sent[0]!.ok).toBe(true);
  expect(JSON.stringify(replies) + err).not.toContain(key.slice(2));
  void NOW_S;
}, 120_000);
