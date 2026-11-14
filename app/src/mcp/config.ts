import { type Address, type Hex } from "viem";
import { z } from "zod";
import { isProduction, KEY_ROLES, KeyConfigError, resolveKey } from "../keys";
import { ipLiteral, type ClientAddressOptions } from "./client-address";

// MCP settings live in this module only (not the app-wide config), so this lane does not touch config.ts.

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const policySchema = z.object({
  owner: address,
  budgetUsdg: z.string().regex(/^\d+$/),
  spentUsdg: z.string().regex(/^\d+$/).default("0"),
  maxPerTradeUsdg: z.string().regex(/^\d+$/),
  expiresAt: z.number().int().nonnegative(),
  canSell: z.boolean().default(false),
  canBack: z.boolean().default(false),
  revoked: z.boolean().default(false),
  markets: z.array(hex32).default([]),
});
export type PolicyMirror = z.infer<typeof policySchema>;

export type RequestedMode = "read_only" | "prepare" | "send";

const flag = z.enum(["0", "1", "true", "false", ""]).default("0");
const schema = z.object({
  OD_API_URL: z.string().url().default("http://127.0.0.1:3100"),
  // The agent key (AGENT_KEYSTORE + AGENT_KEYSTORE_PASSWORD_FILE, or AGENT_KEY in development) is read by keys.ts. Never logged, never returned by a tool.
  AGENT_OWNER: address.optional(),
  AGENT_ROUTER: address.optional(),
  AGENT_RPC_URL: z.string().url().default("https://rpc.chain.robinhood.com"),
  AGENT_CHAIN_ID: z.coerce.number().int().positive().default(4663),
  // Dev fallback: read the policy from AGENT_POLICY instead of the router. Off by default, refused in production; the chain is the authority.
  AGENT_POLICY_FROM_ENV: flag,
  AGENT_POLICY: z.string().optional(),
  MCP_MODE: z.enum(["read_only", "prepare", "send"]).optional(),
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(60),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3102),
  MCP_HTTP_TOKEN: z.string().min(16).optional(),
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  // Where the HTTP transport reads the caller's address: blank = the API's own header (API_CLIENT_IP_HEADER) else X-Forwarded-For.
  MCP_CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]{0,64}$/).default(""),
  MCP_TRUSTED_PROXIES: z.string().default("loopback"),
  API_CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]{0,64}$/).default(""),
});

export interface McpSettings {
  readonly apiUrl: string;
  readonly agentKey: Hex | undefined;
  readonly owner: Address | undefined;
  readonly router: Address | undefined;
  readonly rpcUrl: string;
  readonly chainId: number;
  /** The mode asked for. The mode that runs is never above what the key and the on-chain policy allow (index.ts). */
  readonly requestedMode: RequestedMode;
  /** Only set with AGENT_POLICY_FROM_ENV=1 (dev, never in production). */
  readonly policy: PolicyMirror | undefined;
  readonly policyFromEnv: boolean;
  readonly rateLimitPerMinute: number;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly httpToken: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly clientAddress: ClientAddressOptions;
  readonly forwardHeaders: readonly string[];
}

export function loadMcpSettings(source: Record<string, string | undefined> = process.env): McpSettings {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Issue paths only: values (a key, a token) must not reach an error message.
    throw new Error(`Invalid MCP configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const v = parsed.data;
  const production = isProduction(source);
  // AGENT_KEY is the documented development spelling of the agent role's raw key; production refuses it like any raw key.
  const keySource = source.AGENT_KEY && !source[KEY_ROLES.agent.raw] ? { ...source, [KEY_ROLES.agent.raw]: source.AGENT_KEY } : source;
  let agentKey: Hex | undefined;
  try {
    agentKey = resolveKey(KEY_ROLES.agent, keySource);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new Error(`Invalid MCP configuration: ${error.message}`);
    throw error;
  }
  const policyFromEnv = v.AGENT_POLICY_FROM_ENV === "1" || v.AGENT_POLICY_FROM_ENV === "true";
  if (policyFromEnv && production) throw new Error("Invalid MCP configuration: AGENT_POLICY_FROM_ENV is refused when NODE_ENV=production; the chain is the only policy authority");
  let policy: PolicyMirror | undefined;
  if (policyFromEnv && v.AGENT_POLICY) {
    try { policy = policySchema.parse(JSON.parse(v.AGENT_POLICY)); }
    catch { throw new Error("Invalid MCP configuration: AGENT_POLICY must be JSON with owner, budgetUsdg, maxPerTradeUsdg, expiresAt (raw USDG, 6 dp), markets (bytes32 ids)"); }
  }
  const allowedOrigins = v.MCP_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    if (origin !== "*" && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
      throw new Error("Invalid MCP configuration: MCP_ALLOWED_ORIGINS takes * or origins such as https://app.example (scheme, host, optional port)");
    }
  }
  const trustedProxies = v.MCP_TRUSTED_PROXIES.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const proxy of trustedProxies) {
    if (proxy !== "loopback" && !ipLiteral(proxy)) throw new Error("Invalid MCP configuration: MCP_TRUSTED_PROXIES takes loopback and IP addresses");
  }
  const apiHeader = v.API_CLIENT_IP_HEADER.toLowerCase();
  const clientAddress: ClientAddressOptions = { header: (v.MCP_CLIENT_IP_HEADER || apiHeader || "x-forwarded-for").toLowerCase(), trustedProxies };
  const forwardHeaders = [...new Set(["x-forwarded-for", ...(apiHeader ? [apiHeader] : [])])];
  return {
    apiUrl: v.OD_API_URL.replace(/\/+$/, ""), agentKey,
    owner: (v.AGENT_OWNER ?? policy?.owner) as Address | undefined, router: v.AGENT_ROUTER as Address | undefined,
    rpcUrl: v.AGENT_RPC_URL, chainId: v.AGENT_CHAIN_ID,
    // No key: read only, whatever was asked. A key with no stated mode asks for the most it may do.
    requestedMode: agentKey ? (v.MCP_MODE ?? "send") : "read_only",
    policy, policyFromEnv, rateLimitPerMinute: v.MCP_RATE_LIMIT_PER_MINUTE,
    httpHost: v.MCP_HTTP_HOST, httpPort: v.MCP_HTTP_PORT, httpToken: v.MCP_HTTP_TOKEN, allowedOrigins, clientAddress, forwardHeaders,
  };
}
