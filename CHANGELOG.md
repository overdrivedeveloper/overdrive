# Changelog

## Unreleased

Nothing is released or deployed yet. What exists in the repository:

- Contracts: gear token, factory and registry; minter with a single pricing path; Governor house book with risk loops and insurance; backer vaults with sealed liquidation batches; Uniswap v4 hook and miner; oracle guard, volatility oracle, market hours and TWAP readers; fees, buy-burn and stake; agent router and paymaster; maths libraries. Non-upgradeable cores, admin through a 48 hour timelock.
- Services: API, indexer, crank, hedger, liquidator, MCP server and migrations, with all configuration in `app/src/config.ts`.
- `sdk/` TypeScript client generated from the API spec.
- `mcp/` agent MCP package and guide.
- `vol-engine/` volatility engine and `risk-sim/` stress simulation.
- `scripts/ci-local.sh` local CI, pre-commit public guard and commit-msg guard.

Fix round 10 (independent check 7):

- A sell on a reading that is not live (market closed, calendar unknown, halted) is paid only when every leg's reference is a Pyth print inside `refMaxAge`. With a v3 TWAP as the only reference it is refused `UseQueue` (direct and hook paths, `quote` returns `queued`), and the exit is the sell queue, filled at the first live round (I7-1). In session nothing changes.
- A feed round printed before a calendar close of 24 hours or more is not a live price at the reopen: the market reads HALTED until the feed prints again. New view `ODMarketHours.closedBetween`, new constant `ODOracleGuard.LONG_CLOSE` (I7-2). `IODMarketHours` ABI regenerated.
- `contracts/AUDIT-SCOPE.md` lists every file in scope, generated and checked in CI by `script/ci/audit-scope.py`.
- SECURITY.md: scope section refreshed, I7-1 and I7-2 entries, the weekend exit stated under accepted risks, the liquidation bonus wording of the sale credit residual made exact (R7-3).

Fix round 9 (independent check 6):

- Direct sales no longer take USDG out of the Governor (I6-1, I4-1b). `onBackerMint` books the proceeds of a sale to the Governor as sale credit: collateral of the vault that the Governor holds, locked behind the sold debt and paid to the backer contract from free cash only as that debt is repaid or liquidated. New: `ODGovernor.saleCredit`, `settleSaleCredit` (backer only), events `SaleCreditBooked` and `SaleCreditSettled`; `ODBacker.vaultHeld`, `totalHeld`. `ODBacker.withdraw` pays out only collateral that is not held. NAV subtracts the credit.
- The fix round 8 rule "a sell that leaves net below zero is paid from free cash only" is removed: a holder sell is paid from free cash, the exit reserve, then insurance at any net.
- System invariants S19 to S21 (reserve and insurance pay holders only, holder exit liveness against direct sales, proceeds stay in the Governor), with an attacker actor in the handler.
- `pyth-push`: the reference health check and its critical alert run on every pass, also with no Hermes key or a refused key; three failed Hermes passes in a row are critical (I6-3).
- SECURITY.md: the I4-4, I4-1b, I6-1, I6-2 and I6-4 entries state what is closed, what is accepted and what is left.

Fix round 8 (audit rescore 5 and independent check 5):

- Liquidation fails closed on a disagreeing reference: `sealBatch` reverts and `executeBatch` voids while `ODOracleGuard.liquidationBlock` reports `NOT_LIVE`, `CONTINUITY`, `SPLIT_PENDING`, `REF_UNAVAILABLE` or `REF_BAND` (I5-1). The 15 minute round rule at seal is removed (I5-3).
- `repayWithUsdg` and `withdraw` with debt need a reference or a round at most 15 minutes old; `setMarket` caps the in-session age at 3 days; ETH and SPY `maxAgeInSession` lowered to 259,200 in the configs (I4-3).
- Keeper moves to the exit reserve are held to `Params.maxReserveMoveBps` per 24 hours; new `moveFromExitReserve` (timelock); pushed session windows at most 5 days apart (I4-5).
- One vault owner holds at most `Params.maxLockOwnerBps` of the backer lock ceiling; new view `backerLockOf` (L-12). `onBackerMint`, `onBackerRepay` and `absorbLiquidation` take the vault owner.
- The post-deploy check fails when a market has no reference source (no v3 pool and no Pyth id).
- Push gate: the required jobs now include `contracts` and `slither`; a stamp from an `--only` run does not open the gate; only the stamp's job list is read. npm in the publish workflow is pinned to an exact version and the hygiene check enforces it (I5-4).
- `test/fork/OracleFork.t.sol` is deterministic on any day: a feed past its in-session age limit must read HALTED, one inside it must read live.
