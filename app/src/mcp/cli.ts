import { KEY_ROLES, keyVariables } from "../keys";
import { loadMcpSettings } from "./config";
import { createMcpHttpApp, httpStartupProblem } from "./http";
import { buildMcp } from "./index";
import type { PinnedDeployment } from "./pinned";
import { serveHttp } from "./serve";
import { runStdio, stdinLines } from "./stdio";

// The MCP server's command line, shared by `bun src/bin/mcp.ts` (this repository) and the npm package (bundled for Node
// from this same code). `--http`: the hosted flavour, read only, no key at all, streamable HTTP on MCP_HTTP_HOST:MCP_HTTP_PORT.
// Default and `--stdio`: for an agent host, which may sign with its own session key. stdout is the protocol channel in
// stdio mode, so every diagnostic goes to stderr and no secret is ever printed.

export interface McpCliOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** OD_API_URL when the environment does not set one. Default: the config's own (the local API). */
  readonly defaultApiUrl?: string;
  readonly version?: string;
  /** The deployment the npm package pins (pinned.ts). */
  readonly pin?: PinnedDeployment;
}

const note = (text: string) => process.stderr.write(`[overdrive-mcp] ${text}\n`);

/** True when any agent key variable (raw key, keystore or its password file) is set. */
export function agentKeyConfigured(env: Record<string, string | undefined>): boolean {
  return [...keyVariables(KEY_ROLES.agent), "AGENT_KEY"].some((name) => (env[name] ?? "").trim() !== "");
}

export function cliEnvironment(env: Record<string, string | undefined>, options: Pick<McpCliOptions, "defaultApiUrl">) {
  const out = { ...env };
  if (options.defaultApiUrl && !(out.OD_API_URL ?? "").trim()) out.OD_API_URL = options.defaultApiUrl;
  return out;
}

/** The hosted HTTP server holds no key: any key variable is a startup refusal, and the mode is read_only. */
export function hostedProblem(env: Record<string, string | undefined>): string | undefined {
  return agentKeyConfigured(env) ? "refusing to serve HTTP with an agent key: the hosted server is read only and holds no key (unset AGENT_KEY, AGENT_KEYSTORE)" : undefined;
}

export async function runMcpCli(options: McpCliOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const http = (options.argv ?? process.argv).includes("--http");
  // This process never signs as any role but the agent, whatever the environment holds.
  for (const role of [KEY_ROLES.crank, KEY_ROLES.hedger, KEY_ROLES.liquidator, KEY_ROLES.volSigner, KEY_ROLES.volSender, KEY_ROLES.paymasterSigner]) for (const variable of keyVariables(role)) delete env[variable];
  if (http) {
    const problem = hostedProblem(env);
    if (problem) { note(problem); process.exit(1); }
  }
  let started: Awaited<ReturnType<typeof buildMcp>>;
  let settings: ReturnType<typeof loadMcpSettings>;
  try {
    settings = loadMcpSettings(cliEnvironment(env, options));
    started = await buildMcp(settings, { ...(options.version ? { version: options.version } : {}), ...(options.pin ? { pin: options.pin } : {}) });
  } catch (error) {
    // The messages name variables and codes, never a value (a key, a token).
    note(error instanceof Error ? error.message : "Invalid MCP configuration.");
    process.exit(1);
  }
  const { server, agent, mode } = started;
  note(agent ? `mode ${mode} for agent ${agent.account.address}` : "read-only (no agent key)");

  if (http) {
    const problem = httpStartupProblem(settings, false);
    if (problem) { note(problem); process.exit(1); }
    const app = createMcpHttpApp(server, { token: settings.httpToken, allowedOrigins: settings.allowedOrigins, clientAddress: settings.clientAddress, readOnly: true });
    const listener = await serveHttp({ hostname: settings.httpHost, port: settings.httpPort, fetch: app.fetch, idleTimeoutSeconds: 30 });
    note(`listening on ${settings.httpHost}:${listener.port}/mcp (caller address from ${settings.clientAddress.header} via ${settings.clientAddress.trustedProxies.join(", ")})`);
    const stop = () => { listener.stop(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else {
    await runStdio(server, stdinLines(), (line) => process.stdout.write(`${line}\n`), agent?.account.address ?? "stdio");
  }
}
