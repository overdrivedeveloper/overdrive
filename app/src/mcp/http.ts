import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { rateLimitKey } from "../api/rate-limit";
import { callerAddress } from "./api-client";
import { DEFAULT_CLIENT_ADDRESS, resolveClientAddress, type ClientAddressOptions } from "./client-address";
import { endpointFor, LANDING_HEADERS, landingHtml, landingJson, wantsHtml } from "./landing";
import type { McpServer } from "./server";

export interface McpHttpOptions {
  /** Bearer token. Required whenever the server holds an agent key. */
  readonly token: string | undefined;
  /** Browser origins allowed to call (CORS). "*" = any origin, refused at startup when the server holds an agent key.
   * Requests without an Origin header (desktop and command-line MCP clients) are always allowed. */
  readonly allowedOrigins: readonly string[];
  /** Where the caller's address comes from. Default: X-Forwarded-For, trusted from loopback peers only (Caddy). */
  readonly clientAddress?: ClientAddressOptions;
  /** The TCP peer of a request. Default: Bun's socket address. Tests pass one in. */
  readonly peerAddress?: (context: Context) => string | undefined;
  /** Hosted read-only server (no key at all): any origin may call it (CORS open) unless a token is set. */
  readonly readOnly?: boolean;
}

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 20;

const digest = (value: string) => createHash("sha256").update(value).digest();
const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id: null, error: { code, message } });

function socketAddress(context: Context): string | undefined {
  try { return getConnInfo(context).remote.address; } catch { return undefined; }
}

/** Why the HTTP transport must not start with these settings, or undefined when it may. */
export function httpStartupProblem(settings: { httpToken: string | undefined; allowedOrigins: readonly string[] }, hasAgentKey: boolean): string | undefined {
  if (!hasAgentKey) return undefined;
  if (!settings.httpToken) return "refusing to serve HTTP with an agent key and no MCP_HTTP_TOKEN (16+ characters)";
  if (settings.allowedOrigins.includes("*")) return "refusing to serve HTTP with an agent key and MCP_ALLOWED_ORIGINS=*";
  return undefined;
}

/** MCP streamable HTTP, request/response flavour: POST /mcp with one JSON-RPC message (or a batch), JSON back. */
export function createMcpHttpApp(server: McpServer, options: McpHttpOptions) {
  const app = new Hono();
  const origins = new Set(options.allowedOrigins);
  const anyOrigin = (options.readOnly === true || origins.has("*")) && !options.token;
  const addressOptions = options.clientAddress ?? DEFAULT_CLIENT_ADDRESS;
  const peerOf = options.peerAddress ?? socketAddress;
  const allowed = (origin: string) => anyOrigin || origins.has(origin);

  // Never a stack trace or an internal message in a response.
  app.onError((_error, context) => context.json(rpcError(-32603, "Internal error."), 500));
  app.notFound((context) => context.json({ error: "NOT_FOUND", message: "The MCP endpoint is POST /mcp." }, 404));

  app.use("/mcp", async (context, next) => {
    // DNS-rebinding guard: a browser page on another origin must not reach a local agent server. An allowed browser origin
    // gets CORS headers (no credentials: the bearer token is sent by the client itself).
    const origin = context.req.header("origin");
    if (origin) {
      if (!allowed(origin)) return context.json({ error: "FORBIDDEN_ORIGIN" }, 403);
      context.header("Access-Control-Allow-Origin", anyOrigin ? "*" : origin);
      context.header("Vary", "Origin");
      if (context.req.method === "OPTIONS") {
        context.header("Access-Control-Allow-Methods", "POST, OPTIONS");
        context.header("Access-Control-Allow-Headers", "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id");
        context.header("Access-Control-Max-Age", "600");
        return context.body(null, 204);
      }
    } else if (context.req.method === "OPTIONS") {
      return context.body(null, 204, { Allow: "POST, OPTIONS" });
    }
    if (options.token) {
      const supplied = context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!timingSafeEqual(digest(supplied), digest(options.token))) return context.json({ error: "UNAUTHORIZED" }, 401);
    }
    return next();
  });
  app.use("/mcp", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(rpcError(-32600, "Request too large."), 413) }));
  app.post("/mcp", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); }
    catch { return context.json(rpcError(-32700, "Parse error."), 400); }
    // The caller's address: from the proxy's header only when the TCP peer is a trusted proxy (Caddy on loopback), the
    // hop that proxy wrote, an IP literal; otherwise the peer itself. It keys the MCP's own limiter (IPv4 address or IPv6
    // /64) and is forwarded to the API so its per-client limits count each caller on its own (F40). The Authorization
    // header picks the bucket only when it was checked against MCP_HTTP_TOKEN: on a public server without a token an
    // arbitrary value would be a fresh bucket per call.
    const address = resolveClientAddress(peerOf(context), context.req.header(addressOptions.header), addressOptions);
    const callerKey = options.token ? `t:${digest(options.token).toString("hex").slice(0, 16)}`
      : `ip:${address ? rateLimitKey(address) : "unknown"}`;
    const batch = Array.isArray(body);
    const messages: unknown[] = Array.isArray(body) ? body : [body];
    if (messages.length === 0 || messages.length > MAX_BATCH) return context.json(rpcError(-32600, "Invalid batch."), 400);
    const run = () => Promise.all(messages.map((m) => server.handle(m, callerKey)));
    const responses = (await (address ? callerAddress.run(address, run) : run())).filter((r) => r !== null);
    if (responses.length === 0) return context.body(null, 202);
    context.header("Cache-Control", "no-store");
    return context.json(batch ? responses : responses[0]!, 200);
  });
  // A person who opens the address in a browser gets a page that says what it is and how to connect; GET / answers the
  // same as JSON for anything that does not ask for HTML. Not on a token-protected (keyed) server.
  const landing = (context: Context) => ({
    endpoint: endpointFor(context.req.header("host"), context.req.header("x-forwarded-proto")),
    keyless: !options.token, tools: server.listing.map((t) => ({ name: t.name, description: t.description })),
  });
  if (!options.token) {
    app.get("/", (context) => wantsHtml(context.req.header("accept"))
      ? context.body(landingHtml(landing(context)), 200, LANDING_HEADERS)
      : context.json(landingJson(landing(context)), 200, { "Cache-Control": "public, max-age=300", Vary: "Accept" }));
  }
  // GET /mcp: no server-initiated stream and no sessions, so an MCP client asking for an event stream (or anything but a
  // page) gets 405, as the streamable HTTP transport allows. A browser asking for HTML gets the page above.
  app.get("/mcp", (context) => !options.token && wantsHtml(context.req.header("accept"))
    ? context.body(landingHtml(landing(context)), 200, LANDING_HEADERS)
    : context.json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" }));
  app.on(["DELETE"], "/mcp", (context) => context.json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" }));
  return app;
}
