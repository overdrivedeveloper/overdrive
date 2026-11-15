# Protocol invariants

Each invariant below is a property the system must hold at all times. Each row names the test file and function that checks it, relative to `contracts/test/`. `invariant_*` functions are Foundry stateful invariant suites (default profile 64 runs; `FOUNDRY_PROFILE=deep` runs 500 runs of 100,000 calls). `testFuzz_*` functions are fuzzed unit properties. `check_*` functions are Halmos symbolic checks (not part of CI). Plain `test_*` rows are example-based checks and prove less than a fuzz or an invariant; they are marked as such.

Run one suite: `cd contracts && forge test --match-contract <Contract>`. Deep profile: `FOUNDRY_PROFILE=deep forge test --match-contract <Contract>`.

## Money and books

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 1 | The Governor's USDG balance covers its cash book plus the exit reserve | `governor/GovernorInvariant.t.sol : invariant_BalanceCoversBooks` |
| 2 | While the exit reserve is above its floor, a holder sell that needs the reserve is paid | `governor/GovernorInvariant.t.sol : invariant_ReserveAboveFloorPaysSells`; example: `governor/ExitReserve.t.sol : test_PayFreeCashThenReserve`, `test_FloorFormula` |
| 3 | Only a sell payment draws the exit reserve, and never for the share of tokens that take supply below the gear's own-minted backer debt (`backerOwnDebt`, debt from mints to owners' wallets); nor for a sell that leaves the gear's net below zero against all backer debt (I4-1b, D32: free cash only, else the queue); the hedger, a sale to the Governor and backer-minted tokens sold back cannot (M-7: that share is paid from the backer sale lock, then free cash). The admin (timelock) cannot take it out of the Governor; it can move it back to free cash (`moveFromExitReserve`, I4-5) | `governor/ExitReserve.t.sol : test_OnlyPayDrawsReserve`, `test_HedgerCannotTouchReserve`, `test_AdminCannotWithdrawReserve`; `governor/Backer.t.sol : test_SoldMintNeverUsesReserve`; `governor/BackerLock.t.sol`, `governor/BackerOwnDebt.t.sol`, `poc/DirectSaleBelowZero.t.sol`; system: S17 |
| 4 | Backer debt recorded in the vaults matches the debt the Governor holds against the Backer | `backer/BackerInvariant.t.sol : invariant_DebtMatchesGovernor`; after liquidation: `backer/LiquidationInvariant.t.sol : invariant_DebtMatches` |
| 5 | Vault collateral is accounted for exactly (what went in equals what is held plus what left by a defined path) | `backer/BackerInvariant.t.sol : invariant_CollateralAccounting`; `backer/LiquidationInvariant.t.sol : invariant_CollateralConserved` |
| 6 | A liquidation splits the collateral without creating or losing a unit (executor bonus, insurance, Governor, vault owner) | `backer/Liquidation.t.sol : testFuzz_SplitConserves`; example: `test_LiquidationSplit` |
| 7 | Fee distribution conserves: every unit received is paid, held in its bucket, or burned, none is created | `fees/Fees.t.sol : testFuzz_DistributeConserves`; the splits must sum to 10,000 bps: `test_SplitMustSum` |
| 8 | The fee taken from a backer's toll never exceeds the toll earned | `backer/Toll.t.sol : testFuzz_FeeNeverExceedsTollEarned` |
| 9 | Gear token balances are conserved across transfers, mints and burns | `gear/GearToken.t.sol : testFuzz_BalancesConserved` |

## Holders

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 10 | Holders are never liquidated: a liquidation leaves every holder balance untouched | `backer/LiquidationInvariant.t.sol : invariant_HoldersUntouched`; `backer/BackerInvariant.t.sol : invariant_NoHolderBalanceChanges`; example: `backer/Liquidation.t.sol : test_HolderBalancesUntouched` |
| 11 | A holder can sell under every pause combination the contracts define | `minter/Sell.t.sol : testFuzz_SellUnderEveryPause`; example: `test_SellUnderEveryPause` |
| 12 | A pending unstake and a stake remain slashable; a slash is pro rata and capped by what is staked | `stake/Stake.t.sol : test_PendingUnstakeSlashable`, `test_SlashProRata`, `test_SlashCappedByStake`; `testFuzz_SlashNeverReverts` |

## Pricing and toll

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 13 | The toll multiplier (stock split or corporate action) is applied exactly once, whether or not the feed already embeds it | `oracle/OracleGuard.t.sol : testFuzz_MultiplierAppliedOnce`; examples: `test_MultiplierAppliedOnce_Embedded`, `test_MultiplierAppliedOnce_NotEmbedded` |
| 14 | The normalisation factor is monotone: a positive toll never raises it, a negative toll never lowers it, more time at a positive rate never leaves it higher, and it stays inside its hard bounds | `math/NormFuzz.t.sol : testFuzz_StepBounds`, `testFuzz_StepAdditive`; symbolic: `halmos/NormSymbolic.t.sol : check_StepNeverIncreasesForPositiveToll`, `check_StepNeverBelowMin` |
| 15 | The normalisation step never reverts for any factor, rate or gap | `math/NormFuzz.t.sol : testFuzz_StepNeverReverts`; `math/Toll.t.sol : testFuzz_TollClampNeverReverts` |
| 16 | The contract's accrual equals the library's step for the elapsed gap, with the higher of the stored and current rate | `minter/Accrue.t.sol : test_AccrueMatchesNormLibrary`, `test_GapUsesMaxRate` (example-based) |
| 17 | The gear index is monotone in the price | `math/IndexFuzz.t.sol : testFuzz_Monotone`, `testFuzz_ValueMonotoneInPrice` |
| 18 | The gap rate never favours the caller | `math/Toll.t.sol : test_GapRateNeverFavoursCaller` (example-based) |
| 19 | The quote equals the execution, for a direct minter buy and for a swap through the hook | `minter/Buy.t.sol : testFuzz_ExactInRounding` (asserts quote = execution); `hook/HookQuote.t.sol : testFuzz_QuoteEqualsSwapDeltas`; example: `test_QuoteEqualsSwapDeltas` |
| 20 | Hook gating matches the minter's gating | `hook/Hook.t.sol : testFuzz_HookMatchesMinterGating` |
| 21 | Buy rounding is exact: tokens out are the floor of USDG in over price, and the price is the value plus the spread, rounded up | `minter/Buy.t.sol : testFuzz_ExactInRounding`, `testFuzz_ExactOutRounding` |

## Risk and stake

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 22 | The stress figure equals an independent brute-force computation | `governor/Stress.t.sol : testFuzz_StressMatchesBruteForce` |
| 23 | Stake: assets held cover shares, rewards stay solvent, shares add up and never outlive their assets (exits round down against the leaver, so a dust slash cannot leave shares with totalAssets = 0) | `stake/StakeInvariant.t.sol : invariant_AssetsHeld`, `invariant_RewardsSolvent`, `invariant_SharesAddUp`; `poc/StakeDustShares.t.sol : test_Repro_DustSlashLeavesSharesWithNoAssets` |
| 24 | Stake: only the Governor and the Backer can slash; stake is read by the cores only through the fee discount and the slash | `stake/Stake.t.sol : test_SlashOnlyCallers`, `test_CoresUseOnlyDiscountAndSlash`; CI also greps for stake reads outside `src/stake` (`scripts/ci-local.sh : check_stake_usage`) |

## Privilege limits

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 25 | A guardian can only reduce risk (pause, lower a cap, raise a spread, revoke the vol signer); only the admin unpauses | `gear/Registry.t.sol : test_GuardianOnlyLowersRisk`, `test_GuardianCannotUnpause`; `oracle/OracleGuard.t.sol : test_GuardianCannotUnpause`; `oracle/VolOracle.t.sol : test_GuardianRevokes`; `backer/Health.t.sol : test_SetUpliftAdminOnly` (I4-2: the guardian cannot set the uplift, which raises maintenance), `poc/Ind4GuardianUplift.t.sol`; `governor/Pause.t.sol : test_TimelockUnpauses` (all example-based) |
| 26 | Every admin setter refuses values outside its hard bound | `minter/Spread.t.sol : test_TradeParamsBounds`; `oracle/VolOracle.t.sol : test_SetBoundsHardLimits`; `oracle/OracleGuard.t.sol : test_SetMarketBounds`; `gear/Registry.t.sol : test_ListParamBounds`; `fees/BuyBurn.t.sol : test_PerCallCapAndRouteBounds` (all example-based) |

## Fix round 2 properties

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 27 | A gas-starved execute never skips a vault or an insurance draw: every gas limit either liquidates every vault (insurance paid in full) or reverts with the batch open | `audit/GasStarvedExecute.t.sol : testFuzz_SuccessImpliesAllLiquidated`; examples: `test_GasSweepNeverVoidsBatch`, `test_GasSweepNeverSkipsInsurance`, `test_UnderFloorRevertsNamed` |
| 28 | A vault that fails for a real reason keeps its batch open for another executor | `audit/GasStarvedExecute.t.sol : test_BlockedExecutorLeavesBatchOpen` (example-based) |
| 29 | A full `MAX_BATCH` of deep-crash vaults seals and executes under 24M gas on the chain fork (one Orbit transaction is capped near 32M) | `fork/BatchGasFork.t.sol : test_MaxBatchFitsUnder24M`; measurement: `test_ExecuteGasPerVaultCount` (fork, example-based) |
| 30 | A backer mint, sell and repay round trip across a move inside the lag band never profits | `audit/BackerLagRoundTrip.t.sol : testFuzz_M4Backer_RoundTripNeverProfits`, `testFuzz_M4Backer_WiderBand`; example: `test_M4Backer_AllGearsAtTheBand` |
| 31 | Hedge stress is bounded for any posted delta, and USDG in transit to the hedger ages into a stale hedge | `audit/HedgeDeltaTransit.t.sol : testFuzz_L2_StressBoundedForAnyDelta`; examples: `test_L2_TransitAges`, `test_L2_TransitClockNotRefreshedBySmallSends`, `test_L2_HostileDeltaBounded` |
| 32 | The hedge jump window anchors on equity less hedge equity, so top-of-range posts grow NAV linearly (at most 16,000 bps of start over 24 hours), never compounding | `audit/HedgeWindowAnchor.t.sol : test_L5_WindowAnchorExcludesHedge` (example-based) |
| 33 | After `ODFees.sync()` the fee books equal the fee contract's USDG balance | `fees/Fees.t.sol : testFuzz_L3_SyncMakesBooksEqualBalance`; example: `test_L3_UnnotifiedUsdgSyncsIntoSplit` |
| 34 | Every agent action (buy, sell, backer mint) is charged against both the per-trade cap and the budget | `agent/AgentRouter.t.sol : testFuzz_L4_BudgetCoversEveryAction`; examples: `test_L4_SellChargedAgainstCapAndBudget`, `test_L4_BackerMintCharged` |
| 35 | Under a stale hedge a claim with no minimum reverts, and a claim with a minimum never pays above the hedge-free low edge | `audit/StaleHedgeClaim.t.sol : testFuzz_L6_StaleClaimNeverAboveHedgeFree`; example: `test_L6_StaleHedgeClaimWithExplicitMin` |
| 36 | The registry lists at most `MAX_GEARS` (32) gears, and at that cap `pokeRisk`, an LP deposit and a claim each stay under 10M gas on the chain fork | `gear/Registry.t.sol : test_L1_TotalGearCap`; `fork/GearCountGasFork.t.sol : test_GasPerBuyVsGearCount` (example-based) |

## Fix round 3 properties

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 37 | With an independent move per leg (each inside the lag band, any signs, any band from 1 to 300 bps), a round trip never profits, for single and pair gears, on the minter, the backer and the hook | `audit/TwoLegLagRoundTrip.t.sol : testFuzz_TwoLeg_MinterNeverProfits`, `testFuzz_TwoLeg_BackerNeverProfits`, `testFuzz_TwoLeg_HookNeverProfits`; examples: `test_TwoLeg_PairCorners`, `test_TwoLeg_BackerPairCorners`, `test_TwoLeg_HookPairCorners`, `poc/Rescore2PairLag.t.sol : test_PoC_PairBothLegsInsideBandLoses` |
| 38 | Unabsorbed transit up to `TRANSIT_DUST` (1 USDG) never makes `hedgeStale()` true and never passes its age to a later send; transit above it still ages | `poc/Rescore2Transit.t.sol : test_PoC_TransitDustDoesNotStaleFreshHedge`, `test_L8_LaterSendAgesFromItsOwnTime`, `test_L8_AboveDustStillAges`, `test_L8_SubDustSendsAddUp` (example-based) |
| 39 | After `ODFees.distribute`, the fee contract's USDG balance covers pending plus held, including when the Governor settles owed fees back during its own payout | `poc/FeeDoubleBook.t.sol : test_F12_1_DistributeNeverBooksMoreThanHeld` (example-based) |

## Whole-system properties (invariant suite)

One handler drives the real oracle guard, vol oracle, registry and gear tokens, Governor, insurance, ODFees, minter,
backer (real seal and execute), a local v4 PoolManager with ODHook, and a 48 hour TimelockController, across 26
actions and 16 actors (`test/invariant/SystemHandler.sol`, ghosts in `Ghosts.sol`). `invariant_AllSystem` checks S1
to S13 in one long campaign; the deep run is `bash contracts/script/ci/deep-invariants.sh` (250 runs, 50,000 calls).

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| S1 | A holder sell of value at most the exit reserve, with the reserve at or above its floor, both prices present and supply still at or above the gear's own-minted backer debt after it (at any net), never ends in UseQueue | `invariant/SystemInvariant.t.sol : invariant_HoldersExitAboveFloor` |
| S2 | Liquidations never touch holders: holder balances move only by the holder's own trades and queue actions | `invariant/SystemInvariant.t.sol : invariant_HolderBalancesOnlyOwnActions` |
| S3 | Quote equals execution for direct and hook buys and sells in the same state (refusal and queued flag included); the hook quote equals the executed swap | `invariant/SystemInvariant.t.sol : invariant_QuoteEqualsExecution` |
| S4 | Exits are never gated: sell (only UseQueue or BelowMinimum), owner queue cancel, backer token repay, backer deposit, Governor claim (only HedgeStale) | `invariant/SystemInvariant.t.sol : invariant_ExitsNeverGatedByPauses` |
| S5 | Books covered: Governor USDG >= trackedCash + exitReserve; backer USDG >= totalCollateral + pendingFees and totalCollateral = sum of vaults; ODFees USDG >= pending + totalHeld (strict since the F12-1 fix) | `invariant/SystemInvariant.t.sol : invariant_BooksCovered` |
| S6 | The hook holds nothing of its own; the minter holds exactly the escrowed queue tokens and no USDG | `invariant/SystemInvariant.t.sol : invariant_HookHoldsNothing`, `invariant_MinterHoldsOnlyEscrow` |
| S7 | backerDebt(g) = sum of vault debt for g, and netTokens(g) = supply(g) - backerDebt(g) | `invariant/SystemInvariant.t.sol : invariant_DebtAndNetConsistent` |
| S8 | Toll NF is monotone (non-ECO never rises, ECO never falls), stays in [1e9, 1e24], and cumTollPerTokenWad never falls | `invariant/SystemInvariant.t.sol : invariant_NfMonotone` |
| S9 | The exit reserve only falls inside a holder payout at least that size | `invariant/SystemInvariant.t.sol : invariant_ReserveOnlyPaysHolders` |
| S10 | A USDG donation to the Governor, backer, minter, hook or ODFees changes no share price, book, vault health or quote | `invariant/SystemInvariant.t.sol : invariant_DonationsIgnored` |
| S11 | Drawdown is measured on the Governor's own share price; peak >= now; a trip closes buys | `invariant/SystemInvariant.t.sol : invariant_DrawdownOnOwnSharePrice` |
| S12 | The guardian only pauses; only the timelock unpauses | `invariant/SystemInvariant.t.sol : invariant_OnlyTimelockUnpauses` |
| S13 | Fee split conserves: notified = paid out (measured) + pending + held, books move only by notify and distribute (strict since the F12-1 fix) | `invariant/SystemInvariant.t.sol : invariant_FeesConserved` |
| S14 | Gears ever listed <= ODGearRegistry.MAX_GEARS | `invariant/SystemInvariant.t.sol : invariant_GearCountWithinGlobalCap` |
| S15 | A low-gas executeBatch reverts and leaves the batch executable (reads the public MIN_VAULT_GAS) | `invariant/SystemInvariant.t.sol : test_ExecuteBatchGasRule_afterFixAudit2` |
| S16 | ODFees.distribute never books more USDG than it holds when the Governor settles owed fees inside its own payout (F12-1) | `invariant/SystemInvariant.t.sol : test_Repro_FeeDoubleBookOnDistribute` |
| S17 | M-7, the attributable share: in every successful minter sell (holder, vault owner, queue fill) the exit reserve plus insurance drawn is at most the payout share of the tokens that kept supply at or above `backerOwnDebt` (backer debt still open from mints to owners' wallets); a backer sale lock pays at most the other share and never grows in a sell. A sell wholly above that debt may draw the reserve at any net, so net below zero from sales to the Governor alone is no part of it. Per gear `backerOwnDebt <= backerDebt`, a lock exists only while own-minted debt is open, and the Governor balance covers free cash, the exit reserve and every lock. I4-1: the share is measured against the handler's own ghost of wallet-minted debt (per vault: what it minted to its owner, capped by the debt it still carries), never the contract's counter; `backerOwnDebt` equals that ghost per gear and `vaultOwnDebt` per vault, also after a direct sale and USDG buy-back from any vault (`backerRepayUsdg`) | `invariant/SystemInvariant.t.sol : invariant_BackerSupplyNeverDrawsReserve`, reached on purpose by the handler action `crossOwnSell` (an owner mints past the supply above the own-minted debt and sells across it); `script/ci/deep-invariants.sh` fails under 1 crossing sell per 100 handler calls (4,641 in the 100,000 call run of fix round 7, against 7 before); examples: `governor/BackerLock.t.sol`, `governor/BackerOwnDebt.t.sol`, `backer/OwnDebtAttribution.t.sol`, `poc/Ind4OwnDebtDilution.t.sol` |
| S18 | M-8, liveness and the lock ceiling: a holder sell wholly above the wallet-minted debt is never refused `UseQueue` while free cash net of fees owed, the exit reserve and insurance cover its payout (read by the handler before every other direct holder sell, right after an accrue; 690 such sells and 1,205 own mints in the 100,000 call run of fix round 7); right after every successful own mint the locks of all gears are within `Params.maxLockBps` of free cash plus locks | `invariant/SystemInvariant.t.sol : invariant_HolderSellLiveness`; examples: `poc/Rescore4LockGrief.t.sol` |
| S19 | I4-1b (D32): no sell that leaves a gear's net below zero is paid from the exit reserve or insurance; it is paid from free cash (and its own lock) or it queues. Per-owner lock share (L-12): right after an own mint the owner's open locks are within `maxLockOwnerBps` of the lock ceiling | `invariant_HolderSellLiveness` (handler counters `netBelowZeroDraws`, `lockCeilingViolations`) |

## Fund-holding module properties (per-module invariant suites)

Three handlers, one per module that holds funds, each at 100 runs x depth 100 (10,000 handler calls per campaign) in
both the default and deep profiles (inline forge-config). ODFees and ODInsurance run the real contract against mock
USDG (with pause and blocklist) and mock recipients; the sell queue runs on the real protocol from `SystemFixture`.

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| F1 | ODFees USDG balance >= pending + totalHeld, and the gap equals exactly the unsynced donations | `invariant/FeesInvariant.t.sol : invariant_F1_BooksCoveredAndExact` |
| F2 | notify, sync, distribute and release never mint or destroy value: books = notified + synced - paid out, USDG in - out = balance, notify never books USDG that has not arrived; covers the F12-1 path (the Governor settling owed fees back with notify inside fundCash), pulls of half, reverts, unnotified hand-backs, a stake that reverts and blocked pots | `invariant/FeesInvariant.t.sol : invariant_F2_NoValueMinted` |
| F3 | totalHeld = sum of the seven buckets; both splits sum to 10,000 bps; fee params stay at or under MAX_FEE_PARAM_BPS | `invariant/FeesInvariant.t.sol : invariant_F3_HeldSumAndSplits` |
| F4 | Only the admin sets splits, recipients, fee params and notifiers; only notifiers notify; distribute runs at most once per PERIOD | `invariant/FeesInvariant.t.sol : invariant_F4_AuthAndCadence` |
| F5 | A callback recipient cannot re-enter distribute, release or sync during its payout: the re-entering call reverts, nothing is pulled, the bucket keeps its share and the books stay exact (closed in fix round 4; the sync variant had pushed books above the balance) | `poc/FeeReentrantRelease.t.sol : test_Repro_ReentrantReleaseDropsGovernorBooks`, `test_Repro_ReentrantSyncCannotBookInFlightSplit` |
| I1 | ODInsurance holds exactly funded + donated - paid; payouts never exceed what came in | `invariant/InsuranceInvariant.t.sol : invariant_I1_BalanceConserved` |
| I2 | Every cover pays exactly min(asked, balance) to its caller and to nobody else, once; funds and coverer draws never fail with the token live | `invariant/InsuranceInvariant.t.sol : invariant_I2_PayoutsBounded` |
| I3 | Only the Governor and the backer draw (the admin, funders and strangers are refused); coverers are set once and never replaced | `invariant/InsuranceInvariant.t.sol : invariant_I3_OnlyCoverers` |
| Q1 | For every gear the minter holds exactly the tokens of the open tickets (escrow conservation), each open ticket matches what was queued, and the minter holds no USDG | `invariant/SellQueueInvariant.t.sol : invariant_Q1_EscrowEqualsOpenTickets` |
| Q2 | Every queued sell settles (fill pays the recipient exactly its result, at least minUsdgOut, and burns exactly the escrow) or refunds (owner cancel returns exactly the tokens), exactly once; a refused fill or cancel changes nothing; non-owners never cancel | `invariant/SellQueueInvariant.t.sol : invariant_Q2_SettleOrRefundExactly` |
| Q3 | Queue order: ticket ids are sequential from 1 and never reused; ticketCount = tickets ever opened | `invariant/SellQueueInvariant.t.sol : invariant_Q3_TicketOrder` |
| Q4 | Exits never gated: queueSell and an owner cancel succeed under every session, dropped reference, Governor, market or gear pause, price move and cash drain | `invariant/SellQueueInvariant.t.sol : invariant_Q4_ExitsNeverGated` |

## Known gaps

- The sell queue suite does not drive `settleGear` (the 30 day halt settlement); its fill-at-settled-value path is example-based (`minter/Settle.t.sol`).
- Several rows are example-based rather than fuzzed or stateful; they pin the behaviour but do not search for counter-examples.
- The Halmos checks are not run in CI and have not been confirmed to finish on a loaded machine.
- There is no one-to-one table from every external function to its refusal test.
