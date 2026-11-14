import { createPublicClient, getAddress, http, isAddress, type Address } from "viem";
import { chainGearReader, chainPolicyReader, createAgentRuntime, envPolicyReader, resolveMode, viemExecutor, type AgentRuntime, type ChainReader, type Executor, type GearReader, type Mode, type PolicyReader } from "./agent";
import { createApiClient, ToolError, type ApiClient } from "./api-client";
import type { McpSettings } from "./config";
import { pinFor, type PinnedDeployment } from "./pinned";
import { createKeyedLimiter } from "./rate-limit";
import { createMcpServer } from "./server";
import { toolsFor, verifyPin } from "./tools";

export { loadMcpSettings } from "./config";
export { createMcpServer, toolListing } from "./server";
export { createMcpHttpApp, httpStartupProblem } from "./http";
export { resolveClientAddress } from "./client-address";
export { runStdio, stdinLines } from "./stdio";
export { TOOLS, TOOL_NAMES, READ_TOOLS, WRITE_TOOLS, toolsFor } from "./tools";

export interface McpOverrides {
  readonly fetch?: typeof fetch;
  readonly api?: ApiClient;
  readonly executor?: Executor;
  readonly policy?: PolicyReader;
  readonly gears?: GearReader;
  /** Chain reader behind the policy and the gear settings (tests pass a mock). Defaults to a viem client on AGENT_RPC_URL. */
  readonly chain?: ChainReader;
  readonly now?: () => number;
  /** serverInfo.version sent with initialize (the npm package passes its own version). */
  readonly version?: string;
  /** The npm package's pinned deployment (pinned.ts), used on its chain only. */
  readonly pin?: PinnedDeployment;
}

/** An address from /v1/config, read once on first use. */
function configAddress(api: () => ApiClient, name: string, pinned: Address | undefined): () => Promise<Address> {
  let found: Promise<Address> | undefined;
  return () => {
    if (pinned) return Promise.resolve(pinned);
    found ??= (async () => {
      let value: unknown;
      try { value = ((await api().get("/v1/config")) as { contracts?: Record<string, unknown> } | null)?.contracts?.[name]; }
      catch { throw new ToolError("POLICY_READ_FAILED", "An address could not be read: the Overdrive API did not answer."); }
      if (typeof value !== "string" || !isAddress(value)) throw new ToolError("NO_ROUTER", "No such contract address is configured for this deployment.");
      return getAddress(value);
    })().catch((error) => { found = undefined; throw error; });
    return found;
  };
}

/** Wire settings into a running server. The agent key is held only inside the AgentRuntime's account.
 * The mode is resolved here: never above what was asked, the key and the on-chain policy allow (R1). */
export async function buildMcp(settings: McpSettings, overrides: McpOverrides = {}) {
  const pin = pinFor(overrides.pin, settings.chainId);
  if (pin && settings.router && settings.router.toLowerCase() !== pin.router.toLowerCase()) {
    throw new ToolError("DEPLOYMENT_MISMATCH", "AGENT_ROUTER is not the router this package was built for. Nothing was prepared or sent.");
  }
  let api: ApiClient | undefined;
  const now = overrides.now ?? Date.now;
  let agent: AgentRuntime | undefined;
  if (settings.agentKey) {
    const reader = overrides.chain ?? (createPublicClient({ transport: http(settings.rpcUrl) }) as unknown as ChainReader);
    const router = configAddress(() => api!, "ODAgentRouter", pin?.router ?? settings.router);
    const registry = configAddress(() => api!, "ODGearRegistry", pin?.registry);
    const lazyPolicy: PolicyReader = { async read(owner, agentAddress) { return chainPolicyReader(reader, await router()).read(owner, agentAddress); } };
    const lazyGears: GearReader = { async read(id) { return chainGearReader(reader, await registry()).read(id); } };
    agent = createAgentRuntime({
      key: settings.agentKey, owner: settings.owner, router: pin?.router ?? settings.router,
      policy: overrides.policy ?? (settings.policyFromEnv ? undefined : lazyPolicy) ?? lazyPolicy,
      gears: overrides.gears ?? lazyGears,
      executor: (account) => overrides.executor ?? viemExecutor({ rpcUrl: settings.rpcUrl, chainId: settings.chainId, account }),
      now,
    });
    if (settings.policyFromEnv && !overrides.policy) {
      // Dev only (config refuses it in production): rebuild with the environment mirror.
      agent = createAgentRuntime({
        key: settings.agentKey, owner: settings.owner, router: pin?.router ?? settings.router, policy: envPolicyReader(settings.policy, agent.account.address),
        gears: overrides.gears ?? lazyGears, executor: (account) => overrides.executor ?? viemExecutor({ rpcUrl: settings.rpcUrl, chainId: settings.chainId, account }), now,
      });
    }
  }
  api = overrides.api ?? createApiClient(settings.apiUrl, overrides.fetch ?? fetch, { forwardHeaders: settings.forwardHeaders });
  // R8: a pinned package refuses an API that serves other addresses before it answers anything.
  if (pin) await verifyPin(api, pin);
  const mode: Mode = await resolveMode(agent, settings.requestedMode, settings.owner);
  const limiter = createKeyedLimiter({ limit: settings.rateLimitPerMinute, windowMs: 60_000, ...(overrides.now ? { now: overrides.now } : {}) });
  const server = createMcpServer({
    context: { api, agent: mode === "read_only" ? undefined : agent, mode, defaultOwner: settings.owner, router: pin?.router ?? settings.router, pin, now },
    limiter, tools: toolsFor(mode), ...(overrides.version ? { version: overrides.version } : {}),
  });
  return { server, agent, mode };
}
