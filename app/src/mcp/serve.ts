import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// The HTTP listener for `--http`, on either runtime: Bun.serve under Bun (the hosted server), node:http under Node (the
// npm package). Both hand the app a standard Request and a second fetch argument whose requestIP() gives the TCP peer,
// which is what hono/bun's getConnInfo reads, so http.ts resolves the caller's address the same way on both.

export type FetchHandler = (request: Request, env: { requestIP(request: Request): PeerInfo | null }) => Response | Promise<Response>;
export interface PeerInfo { readonly address: string; readonly family: string; readonly port: number }

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: FetchHandler;
  /** Seconds a connection may sit idle before it is closed. Above the API client's 15 s timeout, so a slow tool call is
   * answered rather than cut off. */
  readonly idleTimeoutSeconds: number;
  /** "auto" picks Bun.serve when running under Bun. Tests force "node" to exercise the Node listener under Bun. */
  readonly runtime?: "auto" | "node";
}

export interface HttpListener {
  readonly port: number;
  stop(): void;
}

/** Bodies larger than this are refused before the app sees them; the app's own limit (64 KB, http.ts) is lower. */
export const MAX_NODE_BODY_BYTES = 1024 * 1024;

const jsonError = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });

export async function serveHttp(options: ServeOptions): Promise<HttpListener> {
  const bun = (globalThis as { Bun?: typeof Bun }).Bun;
  if (bun && options.runtime !== "node") {
    const server = bun.serve({
      hostname: options.hostname, port: options.port, idleTimeout: options.idleTimeoutSeconds,
      fetch: (request, srv) => options.fetch(request, srv),
    });
    return { port: Number(server.port), stop: () => { server.stop(true); } };
  }
  return serveNode(options);
}

function serveNode(options: ServeOptions): Promise<HttpListener> {
  const server = createServer((req, res) => { void respond(req, res, options.fetch); });
  // Same idle limit as Bun.serve's idleTimeout: a socket with no traffic for this long is closed.
  server.setTimeout(options.idleTimeoutSeconds * 1000);
  server.requestTimeout = options.idleTimeoutSeconds * 1000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        stop: () => { server.close(); server.closeAllConnections(); },
      });
    });
  });
}

async function respond(req: IncomingMessage, res: ServerResponse, handler: FetchHandler): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_NODE_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" }).end(jsonError(-32600, "Request too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    const method = req.method ?? "GET";
    // The path and query only: the Host header reaches the app as a header (landing.ts validates it), never as the URL.
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://localhost${url.pathname}${url.search}`, { method, headers, ...(body ? { body } : {}) });
    const socket = req.socket;
    const peer: PeerInfo | null = socket.remoteAddress
      ? { address: socket.remoteAddress, family: socket.remoteFamily ?? "", port: socket.remotePort ?? 0 }
      : null;
    const response = await handler(request, { requestIP: () => peer });
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => { if (name !== "set-cookie") out[name] = value; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) out["set-cookie"] = cookies;
    const payload = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
    res.writeHead(response.status, out);
    res.end(payload);
  } catch {
    // Never a stack trace or an internal message in a response.
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(jsonError(-32603, "Internal error."));
    else res.destroy();
  }
}
