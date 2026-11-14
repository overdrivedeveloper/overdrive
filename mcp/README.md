# Overdrive MCP package (private, unpublished)

The repository's MCP server (`../app/src/mcp`) bundled into one Node file, `dist/cli.js`. The package name is a placeholder
until the owner decides; `private: true` so it cannot be published from here.

```sh
cd ../app && bun install --frozen-lockfile
cd ../mcp && bun install --frozen-lockfile
bun run scripts/build.ts --check   # builds, verifies the bundle, runs scripts/smoke.mjs on plain Node
OD_API_URL=http://127.0.0.1:3100 node dist/cli.js            # stdio, for an agent host
OD_API_URL=http://127.0.0.1:3100 node dist/cli.js --http     # read only, no key, POST /mcp
```

Modes, tools, environment and limits are in `MCP.md`. The package carries no key; a signing agent supplies its own
keystore (`AGENT_KEYSTORE` and `AGENT_KEYSTORE_PASSWORD_FILE`).
