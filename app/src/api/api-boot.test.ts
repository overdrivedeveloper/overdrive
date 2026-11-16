import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { createApiSql } from "./../db/client";
import { optionalEnv } from "../config";
import { applyMigrations, createTestDatabase, readOnlyRoleUrl, testDatabaseUrl } from "../testing/db";
import postgres from "postgres";

const db = await createTestDatabase("apiboot");
const children: ChildProcess[] = [];
afterAll(async () => { for (const c of children) c.kill("SIGTERM"); await db?.close(); });

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
async function until<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v !== undefined) return v; } catch { /* not up yet */ } if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); }
}

test("boots_with_production_env_shape_and_serves_quote", async () => {
  if (!db) return;
  await applyMigrations(db);
  const base = new URL(testDatabaseUrl()!);
  base.pathname = `/${db.name}`;
  const roUrl = new URL(await readOnlyRoleUrl(db.sql, db.name)); // runs scripts/api-readonly-role.sql
  void createApiSql; void postgres; void optionalEnv;
  const apiPort = await freePort();
  const anvilPort = await freePort();
  const anvil = spawn(join(process.env.HOME ?? "", ".foundry/bin/anvil"), ["--port", String(anvilPort), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  children.push(anvil);
  const rpc = `http://127.0.0.1:${anvilPort}`;
  await until(async () => (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).ok ? true : undefined);
  const env = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NETWORK: "fork", CHAIN_ID: "31337",
    DATABASE_URL: base.toString(), API_DB_READONLY_URL: roUrl.toString(), DEPLOYMENT_FILE: join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json"),
    RPC_URL_OVERRIDE: rpc, API_PORT: String(apiPort), API_QUOTER: "mock", LOG_LEVEL: "warn",
  };
  const api = spawn("bun", ["run", join(import.meta.dir, "..", "bin", "api.ts")], { env, stdio: ["ignore", "pipe", "pipe"], cwd: join(import.meta.dir, "..", "..") });
  children.push(api);
  let output = "";
  api.stdout?.on("data", (d) => { output += d; }); api.stderr?.on("data", (d) => { output += d; });
  const url = `http://127.0.0.1:${apiPort}`;
  await until(async () => ((await fetch(`${url}/health`)).ok ? true : undefined)).catch((e) => { throw new Error(`${e}: ${output}`); });
  expect(((await (await fetch(`${url}/health`)).json()) as any).ok).toBe(true);
  expect((await fetch(`${url}/v1/gears`)).status).toBe(200);
  const openapi = (await (await fetch(`${url}/openapi.json`)).json()) as any;
  expect(openapi.paths["/v1/quote"]).toBeTruthy();
  const config = (await (await fetch(`${url}/v1/config`)).json()) as any;
  expect(config.chainId).toBe(31337);
  // /v1/quote with the mock hook: the fixture deployment lists no gears, so an unknown gear is a clean 404, never a crash
  expect((await fetch(`${url}/v1/quote?gear=TSLA-SPORT&side=buy&usdg=1000000`)).status).toBe(404);
  expect((await fetch(`${url}/docs`)).status).toBe(200);
}, 60_000);

test("a writable database role is refused at boot", async () => {
  if (!db) return;
  const base = new URL(testDatabaseUrl()!); base.pathname = `/${db.name}`;
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production", NETWORK: "fork", CHAIN_ID: "31337", DATABASE_URL: base.toString(), API_DB_READONLY_URL: base.toString(),
    DEPLOYMENT_FILE: join(import.meta.dir, "..", "testing", "fixtures", "deployment.fork.json"), API_PORT: String(await freePort()), API_QUOTER: "mock", LOG_LEVEL: "error" };
  const api = spawn("bun", ["run", join(import.meta.dir, "..", "bin", "api.ts")], { env, stdio: ["ignore", "pipe", "pipe"], cwd: join(import.meta.dir, "..", "..") });
  children.push(api);
  let out = ""; api.stderr?.on("data", (d) => { out += d; }); api.stdout?.on("data", (d) => { out += d; });
  const code = await new Promise<number | null>((resolve) => api.on("exit", resolve));
  expect(code).toBe(1);
  expect(out).toContain("SELECT-only");
}, 30_000);
