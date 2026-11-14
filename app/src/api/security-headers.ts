import type { MiddlewareHandler } from "hono";

// Response headers for a JSON API that is never rendered in a browser tab and never framed.
// Each header is set only when the route did not already set it, so a future HTML page (for example API docs)
// can ship its own Content-Security-Policy without being overwritten.
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-DNS-Prefetch-Control": "off",
};

export function securityHeaders(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      if (!context.res.headers.has(name)) context.res.headers.set(name, value);
    }
    context.res.headers.delete("X-Powered-By");
  };
}
