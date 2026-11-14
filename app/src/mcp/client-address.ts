import { isIP } from "node:net";

/** Where the HTTP transport takes an MCP caller's address from. */
export interface ClientAddressOptions {
  /** Header the fronting proxy writes the client address into (lowercase). Caddy sets X-Forwarded-For itself and drops the
   * value a client sent, so that is the default; behind Cloudflare's proxy it is cf-connecting-ip (see the server README). */
  readonly header: string;
  /** TCP peers allowed to supply that header: "loopback" (Caddy on the same host) and literal IP addresses. A request
   * from any other peer is counted under its own socket address and the header is ignored, so a client that reaches the
   * port directly cannot pick its own identity. */
  readonly trustedProxies: readonly string[];
}

export const DEFAULT_CLIENT_ADDRESS: ClientAddressOptions = { header: "x-forwarded-for", trustedProxies: ["loopback"] };

/** An IP literal in canonical-ish form (IPv4-mapped IPv6 as IPv4, no brackets, no zone), or undefined if it is not one. */
export function ipLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  text = text.split("%")[0]!;
  if (text.length === 0 || text.length > 45) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  return isIP(text) ? text : undefined;
}

export function isLoopback(address: string): boolean {
  return address === "::1" || (isIP(address) === 4 && address.startsWith("127."));
}

function trusted(peer: string, proxies: readonly string[]): boolean {
  return proxies.some((proxy) => (proxy === "loopback" ? isLoopback(peer) : ipLiteral(proxy) === peer));
}

/**
 * The address an MCP caller is counted under, for the MCP's own limiter and for the API's per-client limits.
 * - The header is read only when the TCP peer is a trusted proxy. Otherwise the peer's own address is used.
 * - From a list (a, b, c) the rightmost hop is taken: it is the one the trusted proxy wrote; anything to its left came from
 *   the client and could be anything.
 * - A value that is not an IP literal is never used.
 * Undefined when nothing trustworthy is known (no socket address and no trusted header): such callers share one bucket.
 */
export function resolveClientAddress(peerRaw: string | undefined, headerValue: string | undefined, options: ClientAddressOptions): string | undefined {
  const peer = ipLiteral(peerRaw);
  if (!peer) return undefined;
  if (!trusted(peer, options.trustedProxies)) return peer;
  const hops = (headerValue ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return ipLiteral(hops[hops.length - 1]) ?? peer;
}
