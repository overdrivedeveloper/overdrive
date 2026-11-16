#!/usr/bin/env node
// Entry point of the npm package (placeholder name). It is the repository's own MCP server (app/src/mcp), bundled for
// Node by scripts/build.ts; nothing here changes what a tool does. The deployment pin (app/src/mcp/pinned.ts) is the
// one generated from deployments/mainnet.json at release: empty until then, so a development build pins nothing.
// OD_API_URL must be set: no hosted address is baked in. The package carries no key.
import { runMcpCli } from "../../../app/src/mcp/cli";
import { MAINNET_DEPLOYMENT } from "../../../app/src/mcp/pinned";
import { version } from "../package.json";

await runMcpCli({ version, pin: MAINNET_DEPLOYMENT });
