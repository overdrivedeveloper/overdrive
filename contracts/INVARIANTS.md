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

## Known gaps

- ODFees, ODInsurance and the minter sell queue hold funds but have no stateful invariant suite yet (fuzz and example tests only).
- Several rows are example-based rather than fuzzed or stateful; they pin the behaviour but do not search for counter-examples.
- The Halmos checks are not run in CI and have not been confirmed to finish on a loaded machine.
- There is no one-to-one table from every external function to its refusal test.
