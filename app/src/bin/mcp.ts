import { runMcpCli } from "../mcp/cli";

// MCP server. Default or --stdio: for an agent host. `--http`: the hosted read-only server on MCP_HTTP_HOST:MCP_HTTP_PORT.
// stdout is the protocol channel in stdio mode, so every diagnostic goes to stderr and no secret is ever printed.
await runMcpCli();
