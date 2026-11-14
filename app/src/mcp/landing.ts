// What a person sees when they open the MCP address in a browser (GET / or GET /mcp with Accept: text/html), and what
// GET / answers as JSON. MCP clients never get this: they POST to /mcp. No domain, link or script is baked in: the
// endpoint shown is the one the caller reached.

export interface LandingInfo {
  /** Absolute endpoint URL as the caller reached it. */
  readonly endpoint: string;
  readonly keyless: boolean;
  readonly tools: readonly { readonly name: string; readonly description: string }[];
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const firstSentence = (text: string) => (/^.*?[.!?](\s|$)/.exec(text)?.[0] ?? text).trim();

/** The endpoint as the caller reached it. A Host that is not a plain host name (it is reflected into the page) falls back to a local address. */
export function endpointFor(host: string | undefined, forwardedProto: string | undefined): string {
  const fallback = "http://127.0.0.1:3102/mcp";
  if (!host || !/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return fallback;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = forwardedProto === "https" || !local ? "https" : "http";
  return `${proto}://${host.toLowerCase()}/mcp`;
}

export function landingJson(info: LandingInfo) {
  return {
    name: "overdrive", description: "Overdrive geared tokens on Robinhood Chain (USDG). This address is for AI agents (MCP).",
    endpoint: info.endpoint, transport: "streamable-http (POST /mcp, JSON)", keyless: info.keyless, tools: info.tools,
    connect: { claudeCode: `claude mcp add --transport http overdrive ${info.endpoint}`, json: { mcpServers: { overdrive: { type: "http", url: info.endpoint } } } },
  };
}

export const LANDING_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Accept",
} as const;

export function landingHtml(info: LandingInfo): string {
  const json = JSON.stringify({ mcpServers: { overdrive: { type: "http", url: info.endpoint } } }, null, 2);
  const tools = info.tools.map((t) => `<li><code>${esc(t.name)}</code> ${esc(firstSentence(t.description))}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overdrive MCP server</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}li{margin:.4rem 0}</style></head><body>
<h1>Overdrive MCP server: this address is for AI agents</h1>
<p>Add it to an AI agent rather than opening it in a browser. Agents that speak the Model Context Protocol can read gears, quotes, positions, the Governor and the exit reserve.${info.keyless ? " This server holds no keys and sends nothing." : ""}</p>
<h2>Connect</h2><pre>claude mcp add --transport http overdrive ${esc(info.endpoint)}</pre><pre>${esc(json)}</pre>
<h2>Tools</h2><ul>${tools}</ul>
<p>Gears can lose value. Nothing here is advice.</p></body></html>`;
}

export const wantsHtml = (accept: string | undefined) => !!accept && /\btext\/html\b/i.test(accept) && !/\btext\/event-stream\b/i.test(accept);
