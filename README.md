# Overdrive

Geared tokens on Robinhood Chain (chain ID 4663): ERC-20s whose value follows an underlying price raised to a fixed power, settled in USDG. Holders are never liquidated; the cost of the gear is a daily toll applied through a normalisation factor.

Status: in development. Not deployed. Unaudited.

## Layout
```
contracts/   Solidity contracts (Foundry): src/interfaces (every IOD interface), test/mocks, lib/ (vendored)
app/         Bun services: API, indexer, crank, hedger, liquidator; deployments/ (one address file per chain), src/abi
scripts/     quiet-run.sh, ci-local.sh, export-abis.sh and their tests
sdk/         TypeScript client
mcp/         Agent MCP server
web/         Website
.githooks/   pre-commit public guard and commit-msg guard
```
