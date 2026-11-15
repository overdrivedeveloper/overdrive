# Changelog

## Unreleased

Nothing is released or deployed yet. What exists in the repository:

- Contracts: gear token, factory and registry; minter with a single pricing path; Governor house book with risk loops and insurance; backer vaults with sealed liquidation batches; Uniswap v4 hook and miner; oracle guard, volatility oracle, market hours and TWAP readers; fees, buy-burn and stake; agent router and paymaster; maths libraries. Non-upgradeable cores, admin through a 48 hour timelock.
- Services: API, indexer, crank, hedger, liquidator, MCP server and migrations, with all configuration in `app/src/config.ts`.
- `sdk/` TypeScript client generated from the API spec.
- `mcp/` agent MCP package and guide.
- `vol-engine/` volatility engine and `risk-sim/` stress simulation.
- `scripts/ci-local.sh` local CI, pre-commit public guard and commit-msg guard.

Fix round 8 (audit rescore 5 and independent check 5):

- Liquidation fails closed on a disagreeing reference: `sealBatch` reverts and `executeBatch` voids while `ODOracleGuard.liquidationBlock` reports `NOT_LIVE`, `CONTINUITY`, `SPLIT_PENDING`, `REF_UNAVAILABLE` or `REF_BAND` (I5-1). The 15 minute round rule at seal is removed (I5-3).
- `repayWithUsdg` and `withdraw` with debt need a reference or a round at most 15 minutes old; `setMarket` caps the in-session age at 3 days; ETH and SPY `maxAgeInSession` lowered to 259,200 in the configs (I4-3).
- Keeper moves to the exit reserve are held to `Params.maxReserveMoveBps` per 24 hours; new `moveFromExitReserve` (timelock); pushed session windows at most 5 days apart (I4-5).
- One vault owner holds at most `Params.maxLockOwnerBps` of the backer lock ceiling; new view `backerLockOf` (L-12). `onBackerMint`, `onBackerRepay` and `absorbLiquidation` take the vault owner.
- The post-deploy check fails when a market has no reference source (no v3 pool and no Pyth id).
- Push gate: the required jobs now include `contracts` and `slither`; a stamp from an `--only` run does not open the gate; only the stamp's job list is read. npm in the publish workflow is pinned to an exact version and the hygiene check enforces it (I5-4).
- `test/fork/OracleFork.t.sol` is deterministic on any day: a feed past its in-session age limit must read HALTED, one inside it must read live.
