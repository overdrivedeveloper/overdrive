// One place that registers a route and records it in the route table (R7). Every public route goes through `defineRoute`.
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { z } from "zod";
import { ErrorBody } from "./schemas";

export type Auth = "public" | "public_rate_limited";
export interface RouteEntry { method: "GET" | "POST"; path: string; auth: Auth; tag: string }
/** The route table: filled as routes register; route-table.test.ts compares it with the app's real routes. */
export const ROUTE_TABLE: RouteEntry[] = [];

export interface RouteSpec {
  method: "get" | "post";
  path: string; // OpenAPI style: /v1/gears/{id}
  summary: string;
  description?: string;
  tag: "system" | "gears" | "quotes" | "governor" | "accounts" | "docs";
  auth?: Auth;
  params?: z.ZodObject<any>;
  query?: z.ZodObject<any>;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  cache?: string; // Cache-Control for 200s
  errors?: readonly (400 | 404 | 409 | 429 | 502 | 503)[];
}

export function defineRoute(app: OpenAPIHono, spec: RouteSpec, handler: (context: Context, input: { params: any; query: any; body: any }) => Promise<Response | object>): void {
  const route = createRoute({
    method: spec.method, path: spec.path, summary: spec.summary, ...(spec.description ? { description: spec.description } : {}), tags: [spec.tag],
    request: {
      ...(spec.params ? { params: spec.params } : {}), ...(spec.query ? { query: spec.query } : {}),
      ...(spec.body ? { body: { content: { "application/json": { schema: spec.body } }, required: true } } : {}),
    },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: spec.response } } },
      ...Object.fromEntries((spec.errors ?? [400]).map((status) => [status, { description: "Error", content: { "application/json": { schema: ErrorBody } } }])),
    },
  });
  if (!ROUTE_TABLE.some((r) => r.method === spec.method.toUpperCase() && r.path === spec.path)) ROUTE_TABLE.push({ method: spec.method.toUpperCase() as "GET" | "POST", path: spec.path, auth: spec.auth ?? "public", tag: spec.tag });
  (app as any).openapi(route, async (context: Context) => {
    const valid = (context.req as any).valid.bind(context.req);
    const input = { params: spec.params ? valid("param") : {}, query: spec.query ? valid("query") : {}, body: spec.body ? valid("json") : undefined };
    const result = await handler(context, input);
    if (result instanceof Response) return result;
    if (spec.cache) context.header("Cache-Control", spec.cache);
    return context.json(result as never, 200);
  });
}
