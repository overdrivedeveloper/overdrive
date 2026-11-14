// Starts the built bundle (dist/cli.js) on plain Node against a local fake API and checks it over stdio and HTTP.
// No network beyond localhost, no real key (a throwaway one made for this run). Run: node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "cli.js");
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) failed += 1; };

const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const config = { chainId: 31337, network: "fork", commit: "smoke", startBlock: 1, external: { usdg: A(1), v4Quoter: A(2) }, contracts: { ODAgentRouter: A(3), ODMinter: A(4), ODGearRegistry: A(5) }, markets: [], gears: [] };
const api = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/v1/config") return res.end(JSON.stringify(config));
  if (url.pathname === "/v1/quote") return res.end(JSON.stringify({ stale: false, buyable: true, amountOut: "1", gear: url.searchParams.get("gear") }));
  res.statusCode = 404; res.end(JSON.stringify({ error: "NOT_FOUND" }));
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

function run(args, env, lines, waitMs = 1500) {
  return new Promise((resolve) => {
    const child = spawn("node", [cli, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    setTimeout(() => child.stdin.end(), waitMs);
    child.on("close", () => resolve({ stdout, stderr, messages: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
  });
}
const toolNames = (r) => (r.messages.find((m) => m.id === 2)?.result?.tools ?? []).map((t) => t.name);
const rpc = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "od_quote", arguments: { gear: "TSLA-SPORT", side: "buy", usdg: "1000000" } } },
];

// 1. no key: read tools only, and the quote answers
const ro = await run([], { OD_API_URL: apiUrl }, rpc);
const names = toolNames(ro);
check(JSON.stringify(names.sort()) === JSON.stringify(["od_exit", "od_gears", "od_governor", "od_positions", "od_quote"]), `no key: read tools only (${names.join(", ")})`);
const quote = ro.messages.find((m) => m.id === 3)?.result;
check(quote && !quote.isError && quote.structuredContent?.data?.buyable === true, "od_quote answers over stdio");

// 2. a throwaway key, no readable policy (no RPC): prepare mode, write tools listed, key never printed
const key = `0x${randomBytes(32).toString("hex")}`;
const keyed = await run([], { OD_API_URL: apiUrl, AGENT_KEY: key, AGENT_OWNER: A(9), AGENT_RPC_URL: "http://127.0.0.1:9" }, rpc, 3000);
const keyedNames = toolNames(keyed);
check(/mode prepare for agent 0x[0-9a-fA-F]{40}/.test(keyed.stderr) && keyedNames.includes("od_buy_gear") && keyedNames.includes("od_back"), "key without a readable policy: prepare mode with the write tools");
check(!keyed.stdout.includes(key) && !keyed.stderr.includes(key) && !keyed.stderr.includes(key.slice(2)), "the key is never printed");

// 3. production refuses a raw key
const prod = await run([], { OD_API_URL: apiUrl, NODE_ENV: "production", AGENT_KEY: key }, []);
check(/only accepts a keystore/.test(prod.stderr) && !prod.stderr.includes(key.slice(2)), "production refuses a raw key");

// 4. --http with a key is refused; without one it serves
const hosted = await run(["--http"], { OD_API_URL: apiUrl, AGENT_KEY: key }, []);
check(/holds no key/.test(hosted.stderr), "--http refuses any key");
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn("node", [cli, "--http"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, OD_API_URL: apiUrl, MCP_HTTP_PORT: String(port) }, stdio: "ignore" });
let served = null;
for (let i = 0; i < 40 && !served; i += 1) {
  await new Promise((r) => setTimeout(r, 150));
  try { served = await (await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json(); } catch { /* not up yet */ }
}
child.kill("SIGTERM");
check((served?.result?.tools ?? []).length === 5, "--http: POST /mcp tools/list answers with the 5 read tools");

api.close();
if (failed) { console.error(`smoke: ${failed} check(s) failed`); process.exit(1); }
console.log("smoke: all checks passed");
