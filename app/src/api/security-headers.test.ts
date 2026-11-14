import { expect, test } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { API_SECURITY_HEADERS, securityHeaders } from "./security-headers";

test("every response carries the security headers, errors and preflights included", async () => {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.use("*", cors({ origin: "https://site.example" }));
  app.get("/ok", (context) => context.json({ ok: true }));
  app.get("/boom", () => { throw new Error("x"); });
  for (const [path, init] of [["/ok", {}], ["/missing", {}], ["/boom", {}], ["/ok", { method: "OPTIONS", headers: { Origin: "https://site.example", "Access-Control-Request-Method": "GET" } }]] as const) {
    const response = await app.request(path, init);
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value);
  }
});

test("the policy forbids framing, referrers and inline content, and HSTS covers two years", () => {
  expect(API_SECURITY_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
  expect(API_SECURITY_HEADERS["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(API_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  expect(API_SECURITY_HEADERS["Strict-Transport-Security"]).toContain("max-age=63072000");
});

test("a route that sets its own Content-Security-Policy keeps it", async () => {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/docs", (context) => { context.header("Content-Security-Policy", "default-src 'self'"); return context.html("<p>docs</p>"); });
  const response = await app.request("/docs");
  expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

import { Writable } from "node:stream";
import pino from "pino";
import { createApiApp } from "./app";
import { harness } from "./test-support";

test("headers_cors_and_log_redaction", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
  const h = await harness("headers", { config: { CORS_ORIGINS: "https://site.example" } });
  if (!h) return;
  try {
    const app = createApiApp({ ...h.deps, logger: pino({ level: "info" }, stream) });
    // security headers on JSON, 404 and error responses
    for (const path of ["/health", "/v1/gears", "/nope", "/v1/gears/%00"]) {
      const response = await app.request(path);
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) if (name !== "Content-Security-Policy" || path !== "/docs") expect(response.headers.get(name)).toBe(value);
    }
    // CORS only for CORS_ORIGINS
    const allowed = await app.request("/health", { headers: { Origin: "https://site.example" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://site.example");
    const other = await app.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin") ?? "").toBe("");
    // a body over 16 KB on an intent is refused
    const big = await app.request("/v1/intent/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(17 * 1024) }) });
    expect(big.status).toBe(400);
    // no wallet address in the logs: the route pattern only
    const wallet = "0x00000000000000000000000000000000000a11ce";
    await app.request(`/v1/account/${wallet}`);
    await app.request(`/v1/quote?gear=TSLA-SPORT&side=buy&usdg=1000000&account=${wallet}`);
    await app.request("/v1/intent/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gear: "TSLA-SPORT", account: wallet, usdg: "1000000" }) });
    const log = lines.join("");
    expect(log).toContain("/v1/account/:address");
    expect(log.toLowerCase()).not.toContain("a11ce");
  } finally { await h.close(); }
});
