# Changelog

## Unreleased

Nothing is released or deployed yet. What exists in the repository:

- Contracts: gear token, factory and registry; minter with a single pricing path; Governor house book with risk loops and insurance; backer vaults with sealed liquidation batches; Uniswap v4 hook and miner; oracle guard, volatility oracle, market hours and TWAP readers; fees, buy-burn and stake; agent router and paymaster; maths libraries. Non-upgradeable cores, admin through a 48 hour timelock.
- Services: API, indexer, crank, hedger, liquidator, MCP server and migrations, with all configuration in `app/src/config.ts`.
- `sdk/` TypeScript client generated from the API spec.
- `mcp/` agent MCP package and guide.
- `vol-engine/` volatility engine and `risk-sim/` stress simulation.
- `scripts/ci-local.sh` local CI, pre-commit public guard and commit-msg guard.
