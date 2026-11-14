import { AsyncLocalStorage } from "node:async_hooks";

/** The address of the MCP caller whose tool call is running. The API counts rate limits per client address, and every
 * MCP request reaches it from 127.0.0.1, so the caller's address is forwarded (X-Forwarded-For, plus the API's own
 * API_CLIENT_IP_HEADER) or all MCP users would share one bucket (F40). Set by the HTTP transport around each request, only
 * with an address it resolved itself (client-address.ts: an IP literal, from a trusted proxy); absent for stdio. */
export const callerAddress = new AsyncLocalStorage<string>();

export interface ApiClientOptions {
  readonly timeoutMs?: number;
  /** Headers that hold the caller's address to the API. Default X-Forwarded-For. */
  readonly forwardHeaders?: readonly string[];
}

export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** Thin JSON client for the REST API (todo 15). A non-2xx answer becomes a ToolError carrying the API's own code. */
export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch, options: ApiClientOptions = {}): ApiClient {
  const { timeoutMs = 15_000, forwardHeaders = ["x-forwarded-for"] } = options;
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      const forwarded = callerAddress.getStore();
      response = await fetchImpl(`${baseUrl}${path}`, {
        method, headers: {
          accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(forwarded ? Object.fromEntries(forwardHeaders.map((header) => [header, forwarded])) : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ToolError("API_UNREACHABLE", "The Overdrive API did not answer. Try again shortly.");
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const record = json && typeof json === "object" ? json as Record<string, unknown> : {};
      // R7: text from the API is data, never part of our own message. The code is kept only when it looks like a code.
      const code = typeof record.error === "string" && /^[A-Z0-9_]{1,40}$/.test(record.error) ? record.error : `HTTP_${response.status}`;
      throw new ToolError(code, `The API answered ${response.status}.`, { apiMessage: typeof record.message === "string" ? record.message.slice(0, 500) : undefined, reason: typeof record.reason === "string" ? record.reason.slice(0, 500) : undefined });
    }
    return json;
  }
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
}
