# Protocol invariants

Each invariant below is a property the system must hold at all times. Each row names the test file and function that checks it, relative to `contracts/test/`. `invariant_*` functions are Foundry stateful invariant suites (default profile 64 runs; `FOUNDRY_PROFILE=deep` runs 500 runs of 100,000 calls). `testFuzz_*` functions are fuzzed unit properties. `check_*` functions are Halmos symbolic checks (not part of CI). Plain `test_*` rows are example-based checks and prove less than a fuzz or an invariant; they are marked as such.

Run one suite: `cd contracts && forge test --match-contract <Contract>`. Deep profile: `FOUNDRY_PROFILE=deep forge test --match-contract <Contract>`.

## Money and books

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 1 | The Governor's USDG balance covers its cash book plus the exit reserve | `governor/GovernorInvariant.t.sol : invariant_BalanceCoversBooks` |
| 2 | While the exit reserve is above its floor, a holder sell that needs the reserve is paid | `governor/GovernorInvariant.t.sol : invariant_ReserveAboveFloorPaysSells`; example: `governor/ExitReserve.t.sol : test_PayFreeCashThenReserve`, `test_FloorFormula` |
| 3 | Only a sell payment draws the exit reserve; the hedger, the admin and a sale to the Governor cannot | `governor/ExitReserve.t.sol : test_OnlyPayDrawsReserve`, `test_HedgerCannotTouchReserve`, `test_AdminCannotWithdrawReserve`; `governor/Backer.t.sol : test_SoldMintNeverUsesReserve` (all example-based) |
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
| 23 | Stake: assets held cover shares, rewards stay solvent, shares add up | `stake/StakeInvariant.t.sol : invariant_AssetsHeld`, `invariant_RewardsSolvent`, `invariant_SharesAddUp` |
| 24 | Stake: only the Governor and the Backer can slash; stake is read by the cores only through the fee discount and the slash | `stake/Stake.t.sol : test_SlashOnlyCallers`, `test_CoresUseOnlyDiscountAndSlash`; CI also greps for stake reads outside `src/stake` (`scripts/ci-local.sh : check_stake_usage`) |

## Privilege limits

| # | Invariant | Checked by (file : function) |
| --- | --- | --- |
| 25 | A guardian can only reduce risk (pause, lower a cap, raise a spread, revoke the vol signer); only the admin unpauses | `gear/Registry.t.sol : test_GuardianOnlyLowersRisk`, `test_GuardianCannotUnpause`; `oracle/OracleGuard.t.sol : test_GuardianCannotUnpause`; `oracle/VolOracle.t.sol : test_GuardianRevokes`; `backer/Health.t.sol : test_SetUpliftGuardianOnlyRaises`; `governor/Pause.t.sol : test_TimelockUnpauses` (all example-based) |
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

## Known gaps

- ODFees, ODInsurance and the minter sell queue hold funds but have no stateful invariant suite yet (fuzz and example tests only).
- Several rows are example-based rather than fuzzed or stateful; they pin the behaviour but do not search for counter-examples.
- The Halmos checks are not run in CI and have not been confirmed to finish on a loaded machine.
- There is no one-to-one table from every external function to its refusal test.
