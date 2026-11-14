import type { OpenAPIHono } from "@hono/zod-openapi";
import { defineRoute } from "../route-kit";
import { z } from "../schemas";

export function registerHealthRoutes(app: OpenAPIHono): void {
  const Health = z.object({ ok: z.literal(true) }).openapi("Health");
  defineRoute(app, { method: "get", path: "/health", summary: "Liveness", tag: "system", response: Health, cache: "public, max-age=2", errors: [] }, async () => ({ ok: true as const }));
}
