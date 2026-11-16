import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Cache policy for read routes that do not set their own header. */
const DEFAULT_CACHE: ReadonlyArray<readonly [string, string]> = [
  ["/health", "public, max-age=2"],
  ["/v1/openapi.json", "public, max-age=300"],
];

/** Weak validator of a response body: same bytes, same tag. */
export function etagOf(body: ArrayBuffer): string {
  return `W/"${createHash("sha1").update(Buffer.from(body)).digest("base64url").slice(0, 27)}"`;
}

/** `If-None-Match` can list several tags or `*`; weak comparison ignores the W/ prefix. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = bare(etag);
  return header.split(",").some((candidate) => bare(candidate) === target);
}

/**
 * Read-route caching: gives the few routes without a Cache-Control header a short one, and adds an ETag to every
 * cacheable (public) GET so clients and the CDN can revalidate with If-None-Match and get an empty 304.
 * Private, no-store, error and streaming responses are left alone.
 */
export function httpCache(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const method = context.req.method;
    if ((method !== "GET" && method !== "HEAD") || context.res.status !== 200) return;
    const path = context.req.path;
    if (!context.res.headers.get("Cache-Control")) {
      const fallback = DEFAULT_CACHE.find(([prefix]) => path === prefix);
      if (fallback) context.header("Cache-Control", fallback[1]);
    }
    const cacheControl = context.res.headers.get("Cache-Control") ?? "";
    if (!/\bpublic\b/.test(cacheControl) || context.res.headers.has("ETag")) return;
    if ((context.res.headers.get("Content-Type") ?? "").includes("text/event-stream")) return;
    const etag = etagOf(await context.res.clone().arrayBuffer());
    context.header("ETag", etag);
    if (matchesEtag(context.req.header("If-None-Match"), etag)) {
      const headers = new Headers(context.res.headers);
      headers.delete("Content-Length");
      headers.delete("Content-Type");
      context.res = new Response(null, { status: 304, headers });
    }
  };
}
