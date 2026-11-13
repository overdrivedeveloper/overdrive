# Overdrive

Geared tokens on Robinhood Chain (chain ID 4663): ERC-20s whose value follows an underlying price raised to a fixed power, settled in USDG. Holders are never liquidated; the cost of the gear is a daily toll applied through a normalisation factor.

Status: in development. Not deployed. Unaudited.

## Layout
```
contracts/   Solidity contracts (Foundry)
app/         Bun services: API, indexer, crank, hedger, liquidator
sdk/         TypeScript client
mcp/         Agent MCP server
web/         Website
.githooks/   pre-commit public guard and commit-msg guard
```
