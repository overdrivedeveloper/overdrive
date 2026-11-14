import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { safeErrorSummary } from "../log";
import { renderDocsHtml } from "./docs";
import { registerCompatRoutes } from "./compat/routes";
import { ApiError } from "./errors";
import { httpCache } from "./http-cache";
import { openApiDocument } from "./openapi";
import { rateLimit, walletsFromBody } from "./rate-limit";
import { registerAccountRoutes } from "./routes/account";
import { registerBackerRoutes } from "./routes/backers";
import { registerConfigRoutes } from "./routes/config";
import { registerExitRoutes } from "./routes/exit";
import { registerFeeRoutes } from "./routes/fees";
import { registerGearHistoryRoutes } from "./routes/gear-history";
import { registerGearRoutes } from "./routes/gears";
import { registerGovernorHistoryRoutes } from "./routes/governor-history";
import { registerGovernorRoutes } from "./routes/governor";
import { registerHealthRoutes } from "./routes/health";
import { registerHedgeRoutes } from "./routes/hedges";
import { registerIntentRoutes } from "./routes/intent";
import { registerIntentActionRoutes } from "./routes/intent-actions";
import { registerQuoteRoutes, quoteServiceOf } from "./routes/quote";
import { registerRiskRoutes } from "./routes/risk";
import { registerStatusRoutes } from "./routes/status";
import { registerTollRoutes } from "./routes/tolls";
import { ROUTE_TABLE } from "./route-kit";
import { securityHeaders } from "./security-headers";
import type { ApiDependencies } from "./types";

export const INTENT_BODY_LIMIT = 16 * 1024;
const WALLET = /^0x[0-9a-fA-F]{40}$/;

export function createApiApp(deps: ApiDependencies, options: { compat?: boolean } = {}): OpenAPIHono {
  const allowedOrigins = new Set(deps.config.CORS_ORIGINS);
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (!result.success) return context.json({ error: "BAD_REQUEST", message: "Invalid request parameters." }, 400);
    },
  });
  const perMinute = deps.config.API_RATE_LIMIT_PER_MINUTE;
  const writeLimit = perMinute === 0 ? 0 : deps.config.API_WRITE_RATE_LIMIT_PER_MINUTE;
  const clientIpHeader = deps.config.API_CLIENT_IP_HEADER;

  app.use("*", securityHeaders());
  app.use("*", cors({
    origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "If-None-Match"],
    exposeHeaders: ["Cache-Control", "ETag", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "RateLimit-Policy"],
    maxAge: 600, credentials: false,
  }));
  app.use("*", async (context, next) => {
    const startedAt = Date.now();
    await next();
    // The route pattern, never the concrete path or query: wallet addresses must not reach the logs.
    deps.logger.info({ method: context.req.method, path: context.req.routePath, status: context.res.status, durationMs: Date.now() - startedAt }, "API request");
  });
  app.use("*", httpCache());
  app.use("*", rateLimit({ limit: perMinute, windowMs: 60_000, clientIpHeader }));
  // Intents: a write-class route (they build calldata) with a small body and its own tighter per-client and per-wallet limit.
  app.use("/v1/intent/*", bodyLimit({ maxSize: INTENT_BODY_LIMIT, onError: (c) => c.json({ error: "BAD_REQUEST", message: "Request body too large." }, 400) }));
  app.on(["POST"], "/v1/intent/*", rateLimit({ limit: writeLimit, windowMs: 60_000, clientIpHeader, walletKeys: walletsFromBody(["account", "recipient"]) }));
  // Website compat procedures that build intents: same body cap and write limit as /v1/intent.
  for (const p of ["trade.quote", "backer.quoteAction", "stake.quoteAction"]) {
    app.use(`/v1/compat/${p}`, bodyLimit({ maxSize: INTENT_BODY_LIMIT, onError: (c) => c.json({ code: "SERVICE_UNAVAILABLE", message: "Request body too large.", retryable: false }, 400) }));
    app.on(["POST"], `/v1/compat/${p}`, rateLimit({ limit: writeLimit, windowMs: 60_000, clientIpHeader, walletKeys: walletsFromBody(["account"]) }));
  }
  // Quotes that name an account are stricter than anonymous ones.
  app.on(["GET"], "/v1/quote", rateLimit({
    limit: writeLimit === 0 ? 0 : writeLimit * 2, windowMs: 60_000, clientIpHeader,
    walletKeys: async (context) => { const a = context.req.query("account"); return a && WALLET.test(a) ? [`wallet:${a.toLowerCase()}`] : []; },
  }));

  const quotes = quoteServiceOf(deps);
  registerHealthRoutes(app);
  registerStatusRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerGearRoutes(app, deps);
  registerGearHistoryRoutes(app, deps);
  registerTollRoutes(app, deps);
  registerQuoteRoutes(app, deps, quotes);
  registerIntentRoutes(app, deps, quotes);
  registerIntentActionRoutes(app, deps, quotes);
  registerGovernorRoutes(app, deps);
  registerGovernorHistoryRoutes(app, deps);
  registerExitRoutes(app, deps);
  registerBackerRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerFeeRoutes(app, deps);
  registerRiskRoutes(app, deps);
  registerHedgeRoutes(app, deps);
  if (options.compat !== false) {
    // The compat routes read the API in process: a copy without the compat routes and without a second rate limit.
    let inner: OpenAPIHono | undefined;
    registerCompatRoutes(app, deps, () => (inner ??= createApiApp({ ...deps, config: { ...deps.config, API_RATE_LIMIT_PER_MINUTE: 0 } }, { compat: false })));
  }

  const document = () => app.getOpenAPI31Document(openApiDocument);
  app.get("/openapi.json", (context) => {
    try { context.header("Cache-Control", "public, max-age=300"); return context.json(document()); }
    catch (error) { deps.logger.error({ err: safeErrorSummary(error) }, "OpenAPI document generation failed"); return context.json({ error: "UPSTREAM", message: "OpenAPI document unavailable." }, 502); }
  });
  app.get("/docs", (context) => {
    try {
      context.header("Cache-Control", "public, max-age=300");
      context.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      return context.html(renderDocsHtml(document()));
    } catch (error) { deps.logger.error({ err: safeErrorSummary(error) }, "API docs rendering failed"); return context.json({ error: "UPSTREAM", message: "API docs unavailable." }, 502); }
  });
  ROUTE_TABLE.push(
    ...(["/openapi.json", "/docs"] as const).filter((p) => !ROUTE_TABLE.some((r) => r.path === p)).map((path) => ({ method: "GET" as const, path, auth: "public" as const, tag: "docs" })),
  );
  app.notFound((context) => context.req.path.startsWith("/v1/compat/")
    ? context.json({ code: "NOT_DEPLOYED", message: "No such procedure.", retryable: false }, 404)
    : context.json({ error: "NOT_FOUND", message: "Route not found." }, 404));
  app.onError((error, context) => {
    if (error instanceof ApiError) return context.json({ error: error.apiError, message: error.message, ...(error.reason ? { reason: error.reason } : {}) }, error.status);
    const record = error && typeof error === "object" ? (error as { status?: unknown }) : undefined;
    const status = typeof record?.status === "number" && record.status >= 400 && record.status < 500 ? record.status : 500;
    deps.logger.error({ err: safeErrorSummary(error), status }, "API request failed");
    if (status === 429) return context.json({ error: "RATE_LIMITED", message: "Too many requests." }, 429);
    if (status >= 500) return context.json({ error: "UPSTREAM", message: "Internal error." }, 502);
    return context.json({ error: "BAD_REQUEST", message: "Bad request." }, 400);
  });
  return app;
}
