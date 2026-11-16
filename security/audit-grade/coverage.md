# Coverage of contracts/src (TEST-5)

Recorded by `.github/scripts/coverage-floor.py --record` from `bash .github/scripts/coverage.sh` (forge coverage --ir-minimum, hermetic suite, src/ only; via_ir source maps make these a floor, not exact). `.github/scripts/ci-local.sh --only coverage` fails when a fresh run is below the src/ total row. The floor is never lowered.

# Coverage of contracts/src (2026-11-16, 2866b6b)

| File | Lines | Branches | Functions |
|---|---|---|---|
| src/agent/ODAgentRouter.sol | 99.00% (99/100) | 80.00% (20/25) | 100.00% (13/13) |
| src/agent/ODPaymaster.sol | 89.02% (146/164) | 84.91% (45/53) | 77.27% (17/22) |
| src/backer/ODBacker.sol | 96.85% (400/413) | 76.42% (94/123) | 100.00% (52/52) |
| src/backer/ODBackerMath.sol | 100.00% (15/15) | 100.00% (2/2) | 100.00% (5/5) |
| src/backer/ODLiquidation.sol | 93.75% (15/16) | 100.00% (7/7) | 100.00% (2/2) |
| src/backer/ODSaleCredit.sol | 73.33% (22/30) | 62.50% (5/8) | 66.67% (2/3) |
| src/fees/ODBuyBurn.sol | 91.07% (51/56) | 52.63% (10/19) | 87.50% (7/8) |
| src/fees/ODFees.sol | 100.00% (105/105) | 88.89% (24/27) | 100.00% (16/16) |
| src/gear/ODGear.sol | 93.75% (15/16) | 100.00% (2/2) | 100.00% (6/6) |
| src/gear/ODGearFactory.sol | 100.00% (9/9) | 100.00% (1/1) | 100.00% (3/3) |
| src/gear/ODGearRegistry.sol | 99.20% (124/125) | 94.00% (47/50) | 100.00% (17/17) |
| src/governor/ODGovernor.sol | 97.05% (427/440) | 79.31% (92/116) | 98.00% (98/100) |
| src/governor/ODGovernorRisk.sol | 95.99% (287/299) | 89.44% (127/142) | 100.00% (26/26) |
| src/governor/ODInsurance.sol | 96.00% (24/25) | 55.56% (5/9) | 100.00% (5/5) |
| src/governor/ODMinter.sol | 96.09% (221/230) | 72.97% (54/74) | 94.74% (36/38) |
| src/governor/ODMinterPricing.sol | 97.14% (136/140) | 89.42% (93/104) | 100.00% (11/11) |
| src/hook/ODHook.sol | 91.40% (85/93) | 85.19% (23/27) | 84.21% (16/19) |
| src/hook/ODHookMiner.sol | 87.50% (7/8) | 100.00% (1/1) | 100.00% (2/2) |
| src/interfaces/ODPowers.sol | 100.00% (6/6) | 100.00% (4/4) | 100.00% (1/1) |
| src/math/ODFixed.sol | 98.08% (51/52) | 100.00% (14/14) | 100.00% (8/8) |
| src/math/ODIndex.sol | 94.74% (36/38) | 89.47% (17/19) | 100.00% (7/7) |
| src/math/ODNorm.sol | 100.00% (32/32) | 100.00% (15/15) | 100.00% (3/3) |
| src/math/ODToll.sol | 100.00% (21/21) | 100.00% (8/8) | 100.00% (6/6) |
| src/oracle/ODCalendar.sol | 100.00% (50/50) | 95.00% (19/20) | 100.00% (7/7) |
| src/oracle/ODMarketHours.sol | 94.66% (124/131) | 87.27% (48/55) | 100.00% (16/16) |
| src/oracle/ODOracleGuard.sol | 96.20% (329/342) | 88.11% (126/143) | 100.00% (32/32) |
| src/oracle/ODTickPrice.sol | 100.00% (24/24) | 100.00% (25/25) | 100.00% (1/1) |
| src/oracle/ODTwapReader.sol | 91.94% (57/62) | 52.17% (12/23) | 100.00% (6/6) |
| src/oracle/ODVolOracle.sol | 100.00% (66/66) | 100.00% (21/21) | 100.00% (13/13) |
| src/stake/ODStake.sol | 97.42% (189/194) | 68.85% (42/61) | 96.15% (25/26) |
| **src/ total** | **96.09%** (3173/3302) | **83.72%** (1003/1198) | **96.84%** (459/474) |
