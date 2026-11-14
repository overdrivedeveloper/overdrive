// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MockHours, ODBackerHarness} from "../backer/BackerFixture.sol";
import {HookFixture} from "../hook/HookFixture.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODOracleGuard} from "overdrive/interfaces/IODOracleGuard.sol";
import {IODMarketHours} from "overdrive/interfaces/IODMarketHours.sol";
import {IODInsurance} from "overdrive/interfaces/IODInsurance.sol";
import {ODRoles} from "overdrive/interfaces/ODRoles.sol";
import {SystemHandler, SystemRefs} from "./SystemHandler.sol";
import {ActorSet} from "./ActorSet.sol";

/// The whole-system invariant suite (todo 12). Real: ODOracleGuard, ODVolOracle, ODGearRegistry and gear tokens,
/// ODGovernor, ODInsurance, ODFees, ODMinter, ODBacker (real liquidation path), a local v4 PoolManager with ODHook, and
/// an OpenZeppelin TimelockController (48 h) holding the admin role used to unpause. Mocks: the Chainlink-shaped
/// feeds, Pyth, the session calendar, Stock Tokens and USDG (external inputs only).
///
/// Each named invariant runs its own short campaign in the default profile; `invariant_AllSystem` checks all of them
/// in one long campaign and is the one the deep profile runs (script/ci/deep-invariants.sh).
contract SystemInvariantTest is HookFixture {
    ODBackerHarness internal backer;
    MockHours internal hrs;
    SystemHandler internal h;
    TimelockController internal timelock;
    ActorSet internal actors;

    /// The real ODBacker (BackerFixture's harness, same wiring) in place of SystemFixture's placeholder address.
    function _deployBacker() internal override returns (address) {
        hrs = new MockHours();
        backer = new ODBackerHarness(
            IERC20(address(usdg)),
            admin,
            guardian,
            IODGearRegistry(address(reg)),
            IODMinter(address(minter)),
            IODGovernor(address(gov)),
            IODOracleGuard(address(guard)),
            IODMarketHours(address(hrs)),
            IODInsurance(address(ins)),
            address(fees)
        );
        return address(backer);
    }

    function setUp() public override {
        super.setUp();
        address seeder = makeAddr("pmSeeder");
        _seedGear(seeder, eco, 20_000e6);
        _seedGear(seeder, ethSport, 20_000e6);

        for (uint256 i; i < 5; ++i) {
            actors.holders[i] = makeAddr(string.concat("holder", vm.toString(i)));
        }
        for (uint256 i; i < 3; ++i) {
            actors.backers[i] = makeAddr(string.concat("backer", vm.toString(i)));
        }
        actors.liquidator = makeAddr("liquidator");
        actors.keeper = makeAddr("keeper");
        actors.hedger = makeAddr("hedger");
        actors.guardian = guardian;
        actors.proposer = makeAddr("timelockProposer");
        actors.stranger = stranger;

        address[] memory proposers = new address[](1);
        proposers[0] = actors.proposer;
        address[] memory executors = new address[](1); // address(0): anyone executes a ready operation
        timelock = new TimelockController(48 hours, proposers, executors, address(0));

        bytes32 adminRole = 0x00;
        vm.startPrank(admin);
        gov.grantRole(adminRole, address(timelock));
        backer.grantRole(adminRole, address(timelock));
        guard.grantRole(adminRole, address(timelock));
        gov.grantRole(ODRoles.KEEPER_ROLE, actors.keeper);
        IODGovernor.Params memory p = gov.getParams();
        p.stressBudgetBps = 5000; // room for holders to trade at size
        p.capScaleBps = 10_000;
        gov.setParams(p);
        vm.stopPrank();
        _poke();

        bytes32[] memory gears = new bytes32[](7);
        (gears[0], gears[1], gears[2], gears[3]) = (cruise, sport, race, eco);
        (gears[4], gears[5], gears[6]) = (reverse, ethSport, pair);
        SystemRefs memory refs = SystemRefs({
            usdg: usdg,
            cal: cal,
            pyth: pyth,
            guard: guard,
            vol: vol,
            reg: reg,
            gov: gov,
            minter: minter,
            fees: fees,
            backer: backer,
            hook: hook,
            router: router,
            timelock: timelock,
            pm: address(pm),
            lp: lp,
            volKey: volKey
        });
        h = new SystemHandler(
            refs,
            actors,
            [TSLA, NVDA, ETH],
            gears,
            [feedOf[TSLA], feedOf[NVDA], feedOf[ETH]],
            [stockOf[TSLA], stockOf[NVDA], MockStockToken(address(0))],
            [sigmaOf[TSLA], sigmaOf[NVDA], sigmaOf[ETH], sigmaOf[vol.pairKey(TSLA, NVDA)]]
        );

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](27);
        sel[0] = SystemHandler.buy.selector;
        sel[1] = SystemHandler.buy.selector; // weighted: trading is the common case
        sel[2] = SystemHandler.sell.selector;
        sel[3] = SystemHandler.sell.selector;
        sel[4] = SystemHandler.queueSell.selector;
        sel[5] = SystemHandler.fillQueued.selector;
        sel[6] = SystemHandler.cancelQueued.selector;
        sel[7] = SystemHandler.warp.selector;
        sel[8] = SystemHandler.movePrice.selector;
        sel[9] = SystemHandler.haltFeed.selector;
        sel[10] = SystemHandler.postVol.selector;
        sel[11] = SystemHandler.accrue.selector;
        sel[12] = SystemHandler.pokeRisk.selector;
        sel[13] = SystemHandler.backerOpen.selector;
        sel[14] = SystemHandler.backerMint.selector;
        sel[15] = SystemHandler.backerRepay.selector;
        sel[16] = SystemHandler.backerWithdraw.selector;
        sel[17] = SystemHandler.backerDeposit.selector;
        sel[18] = SystemHandler.sealAndExecute.selector;
        sel[19] = SystemHandler.governorDeposit.selector;
        sel[20] = SystemHandler.governorRequestAndClaim.selector;
        sel[21] = SystemHandler.donate.selector;
        sel[22] = SystemHandler.guardianPause.selector;
        sel[23] = SystemHandler.timelockUnpause.selector;
        sel[24] = SystemHandler.distributeFees.selector;
        sel[25] = SystemHandler.backerSell.selector; // M-7
        sel[26] = SystemHandler.backerSell.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        bytes4[] memory extra = new bytes4[](5);
        extra[0] = SystemHandler.keeperFundReserve.selector;
        extra[1] = SystemHandler.keeperFundReserve.selector;
        extra[2] = SystemHandler.sealAndExecute.selector;
        extra[3] = SystemHandler.backerMint.selector;
        extra[4] = SystemHandler.backerSell.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: extra}));
    }

    // ============================================================================================ smoke

    /// Every action once, in an order that reaches a liquidation, a queued fill, a timelock unpause and a fee split.
    function test_SystemHandlerSmoke() public {
        h.buy(0, 1, 5_000e6, false, true);
        h.buy(1, 1, 500e18, true, false);
        h.buy(2, 4, 2_000e6, true, true);
        h.sell(0, 1, 100e18, false, true);
        h.sell(1, 1, 50e6, true, false);
        h.queueSell(2, 4, 10e18);
        h.cancelQueued(1, 0);
        h.queueSell(2, 4, 10e18);
        h.fillQueued(1);
        h.backerOpen(0, 1, 1_000e6);
        h.backerMint(0, 0, 450e18, false);
        h.backerSell(0, 100e18);
        h.backerDeposit(1, 0, 10e6);
        h.backerRepay(0, 0, 10e18);
        h.backerWithdraw(0, 0, 1e6);
        h.movePrice(0, 2500);
        h.sealAndExecute(1, 60);
        h.keeperFundReserve(type(uint256).max);
        h.sell(0, 1, 1e18, false, true);
        h.governorDeposit(10_000e6);
        h.governorRequestAndClaim(1e6);
        h.donate(0, 1_000e6);
        h.donate(1, 1_000e6);
        h.donate(3, 1_000e6);
        h.guardianPause(0);
        h.timelockUnpause(0);
        h.warp(2 days);
        h.warp(1 days);
        h.timelockUnpause(0);
        h.haltFeed(2, true);
        h.postVol(0, 3000);
        h.accrue(4);
        h.pokeRisk();
        h.haltFeed(2, false);
        h.warp(5 days);
        h.distributeFees();
        h.governorRequestAndClaim(1e6);
        assertGt(h.batchesSealed(), 0, "a batch was sealed");
        assertEq(h.timelockUnpauses(), 2, "timelock unpaused twice");
        assertGt(h.quoteChecks(), 4, "quotes checked");
        assertGt(h.donationChecks(), 2, "donations checked");
        invariant_AllSystem();
    }

    /// F12-1 minimal repro (found by invariant_AllSystem, deep profile): ODFees.distribute pays the Governor bucket via
    /// Governor.fundCash, which settles the Governor's owed fees back into ODFees and notifies them (pending += x);
    /// ODFees._pay measures only s0 - x as paid, so the bucket also holds x. ODFees then books more USDG than it holds.
    /// Fixed in fix round 3 (_pay counts USDG booked back as pending during the call as paid out): the books stay
    /// covered.
    function test_Repro_FeeDoubleBookOnDistribute() public {
        _buy(bob, sport, 15_000e6); // spread share notified to ODFees while the Governor has cash
        uint256 cash = gov.freeCash();
        vm.prank(admin);
        gov.moveToExitReserve(cash); // no free cash: the next toll fee stays owed
        _warpFresh(1 days);
        minter.accrue(sport);
        uint256 owed = gov.feeOwed();
        assertGt(owed, 0, "a fee is owed");
        assertGt(fees.pending(), 0, "something to split");
        vm.warp(fees.nextDistributionAt());
        _refreshAll();
        fees.distribute();
        assertLt(gov.feeOwed(), owed, "the Governor paid its owed fee inside distribute");
        assertGe(usdg.balanceOf(address(fees)), fees.pending() + fees.totalHeld(), "F12-1: books exceed balance");
    }

    // ============================================================================================ R1 to R12

    /// R1 (headline 1): a holder sell of value <= the exit reserve, with the reserve at or above its floor and both
    /// prices present, is never refused for lack of cash.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_HoldersExitAboveFloor() public view {
        assertEq(h.r1Violations(), 0, "R1: sell refused with reserve >= floor and payout <= reserve");
    }

    /// R2 (headline 2): holder balances move only by the holder's own trades and queue actions (liquidations,
    /// backer mints and repays, settlements, donations and pauses never touch them).
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_HolderBalancesOnlyOwnActions() public view {
        for (uint256 i; i < 5; ++i) {
            address who = h.holderAt(i);
            for (uint256 gi; gi < 7; ++gi) {
                address t = h.tokenAt(gi);
                assertEq(IERC20(t).balanceOf(who), h.expectedBal(who, t), "R2: holder balance moved by someone else");
            }
        }
    }

    /// R3 (headline 3): every buy and sell (direct and through the hook) executed exactly as quoted in the same state,
    /// and the V4Quoter-style hook quote equals the executed hook swap.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_QuoteEqualsExecution() public view {
        assertEq(h.quoteMismatches(), 0, string.concat("R3: ", _str(h.lastMismatch())));
    }

    /// R4: no sell, queue cancel, backer repay or deposit, or Governor claim was refused for a pause, cap, stress,
    /// drawdown or stale input. UseQueue (sells) and HedgeStale (claims) are the only allowed refusals.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_ExitsNeverGatedByPauses() public view {
        assertEq(h.exitsGated(), 0, string.concat("R4: exit refused in ", _str(h.lastGatedAction())));
    }

    /// R5 (GEN-5): balances cover the books.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_BooksCovered() public view {
        assertGe(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve(), "R5: governor books");
        assertGe(usdg.balanceOf(address(backer)), backer.totalCollateral() + backer.pendingFees(), "R5: backer books");
        uint256 sum;
        for (uint256 id = 1; id <= backer.vaultCount(); ++id) {
            (,, uint256 c,,) = backer.vault(id);
            sum += c;
        }
        assertEq(backer.totalCollateral(), sum, "R5: backer collateral sum");
        // strict since the F12-1 fix: no allowance for the Governor's re-entrant fee payment inside distribute
        assertGe(usdg.balanceOf(address(fees)), fees.pending() + fees.totalHeld(), "R5: fees books");
    }

    /// R5: the hook holds nothing of its own (only what was donated to it).
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_HookHoldsNothing() public view {
        assertEq(usdg.balanceOf(address(hook)), h.donatedUsdg(address(hook)), "R5: hook USDG");
        for (uint256 gi; gi < 7; ++gi) {
            assertEq(IERC20(h.tokenAt(gi)).balanceOf(address(hook)), 0, "R5: hook gear tokens");
        }
    }

    /// R5: the minter holds exactly the escrowed queue tokens (and no USDG of its own).
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_MinterHoldsOnlyEscrow() public view {
        assertEq(usdg.balanceOf(address(minter)), h.donatedUsdg(address(minter)), "R5: minter USDG");
        for (uint256 gi; gi < 7; ++gi) {
            address t = h.tokenAt(gi);
            assertEq(IERC20(t).balanceOf(address(minter)), h.escrowOf(t), "R5: minter escrow");
        }
    }

    /// R6: the Governor's backer debt equals the vault debt per gear, and netTokens = supply - backer debt.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_DebtAndNetConsistent() public view {
        uint256[7] memory sum;
        uint256 n = backer.vaultCount();
        for (uint256 id = 1; id <= n; ++id) {
            (, bytes32 vg,, uint256 d,) = backer.vault(id);
            for (uint256 gi; gi < 7; ++gi) {
                if (h.gearAt(gi) == vg) {
                    sum[gi] += d;
                    break;
                }
            }
        }
        for (uint256 gi; gi < 7; ++gi) {
            bytes32 g = h.gearAt(gi);
            assertEq(gov.backerDebt(g), sum[gi], "R6: backer debt");
            assertEq(gov.netTokens(g), int256(IERC20(h.tokenAt(gi)).totalSupply()) - int256(sum[gi]), "R6: net tokens");
        }
    }

    /// R7: NF of non-ECO gears never rises, ECO never falls, all in [MIN_NF, MAX_NF], cumTollPerTokenWad never falls
    /// (checked after every handler call).
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_NfMonotone() public view {
        assertEq(h.nfViolations(), 0, string.concat("R7: NF moved the wrong way in ", _str(h.lastNfViolation())));
    }

    /// M-7, the attributable share: backer supply minted to an owner's wallet never reaches the exit reserve or
    /// insurance. In every successful minter sell (holder, vault owner or queue fill) reserve + insurance drawn <= the
    /// payout share of the tokens that kept supply at or above backerOwnDebt (the gear's backer debt still open from
    /// mints to owners' wallets); the backer sale lock pays at most the other share and never grows in a sell. Net
    /// below zero from sales to the Governor alone is no part of it: such a sell may draw the reserve like any sell.
    /// Per gear backerOwnDebt <= backerDebt, and a lock exists only while own-minted debt is open; the Governor's
    /// balance covers free cash, the exit reserve and every gear's lock.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_BackerSupplyNeverDrawsReserve() public view {
        assertEq(h.m7DrawViolations(), 0, "M-7: reserve or insurance paid a share below the own-minted debt");
        assertEq(h.m7LockViolations(), 0, "M-7: a sell misused a backer sale lock");
        bytes32[7] memory gs = [cruise, sport, race, eco, reverse, ethSport, pair];
        uint256 locks;
        for (uint256 i; i < gs.length; ++i) {
            uint256 lk = gov.backerLock(gs[i]);
            uint256 own = gov.backerOwnDebt(gs[i]);
            assertLe(own, gov.backerDebt(gs[i]), "M-7: own-minted debt above the gear's backer debt");
            if (own == 0) assertEq(lk, 0, "M-7: a lock with no own-minted debt open");
            locks += lk;
        }
        assertGe(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve() + locks, "M-7: locks covered");
    }

    /// R8: the exit reserve only falls inside a holder payout at least that size.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_ReserveOnlyPaysHolders() public view {
        assertEq(h.reserveViolations(), 0, "R8: exit reserve paid a non-holder");
        assertEq(h.reserveDrawn(), h.reservePaidToHolders(), "R8: reserve drawn == reserve paid to holders");
    }

    /// R9 (GEN-3, VAULT-1): a plain USDG transfer to the Governor, backer, minter, hook or fees moves no share price,
    /// book, vault health or quote (before/after twin read around each donation).
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_DonationsIgnored() public view {
        assertEq(h.donationEffects(), 0, "R9: a donation moved a price, book or quote");
    }

    /// R10: the drawdown metric is the vault's own share price (convertToAssets of one share, WAD), the peak is never
    /// below it, and a tripped drawdown closes buys once the cached share price equals the live one.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_DrawdownOnOwnSharePrice() public view {
        uint256 sp = gov.convertToAssets(10 ** gov.decimals()) * 1e12;
        assertEq(gov.sharePriceWad(), sp, "R10: share price");
        (uint256 peak, uint256 nowWad, bool tripped) = gov.drawdown();
        assertEq(nowWad, sp, "R10: drawdown uses the own share price");
        assertGe(peak, nowWad, "R10: peak >= now");
        // the buy gate reads the cached share price (<= equityMaxAge old), so only a cache equal to the live price
        // must agree with the live trip
        (,, uint256 cachedSp) = gov.cachedEquity();
        if (tripped && cachedSp == nowWad) {
            assertTrue(gov.buyBlock(sport, 1e18) != bytes32(0), "R10: tripped drawdown leaves buys open");
        }
    }

    /// R11: the guardian only pauses; only the timelock un-does a pause.
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_OnlyTimelockUnpauses() public view {
        assertEq(h.nonTimelockUnpauses(), 0, "R11: unpaused by someone other than the timelock");
    }

    /// R12: everything notified to ODFees is distributed (measured), held, or still pending (dust included).
    /// forge-config: default.invariant.runs = 16
    /// forge-config: default.invariant.depth = 40
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_FeesConserved() public view {
        assertEq(h.feeViolations(), 0, "R12: fee books moved outside notify/distribute");
        // every notified USDG is paid out (measured), pending or held; strict since the F12-1 fix
        assertEq(h.feesNotified(), h.feesPaidOut() + fees.pending() + fees.totalHeld(), "R12: fees conserved");
    }

    // ============================================================================================ after fix-audit2

    /// PENDING fix-audit2 (L-1, global gear cap): gears ever listed never exceed ODGearRegistry.MAX_GEARS. Skips
    /// itself until the registry exposes MAX_GEARS (enabled automatically once lane/fix-audit2 merges).
    /// forge-config: default.invariant.runs = 4
    /// forge-config: default.invariant.depth = 20
    /// forge-config: deep.invariant.runs = 2
    /// forge-config: deep.invariant.depth = 10
    function invariant_GearCountWithinGlobalCap() public {
        (bool ok, bytes memory ret) = address(reg).staticcall(abi.encodeWithSignature("MAX_GEARS()"));
        if (!ok || ret.length < 32) {
            vm.skip(true);
            return;
        }
        assertLe(reg.gearCount(), abi.decode(ret, (uint256)), "L-1: gear count above MAX_GEARS");
    }

    /// M-6, executeBatch gas rule: an execute with too little gas for a vault reverts and leaves the batch open for
    /// another executor instead of marking it done with the vault unliquidated. Runs now that ODBacker exposes
    /// MIN_VAULT_GAS (it skips only if the getter is ever removed).
    function test_ExecuteBatchGasRule_afterFixAudit2() public {
        (bool ok, bytes memory ret) = address(backer).staticcall(abi.encodeWithSignature("MIN_VAULT_GAS()"));
        if (!ok || ret.length < 32) {
            vm.skip(true);
            return;
        }
        uint256 minGas = abi.decode(ret, (uint256));
        h.backerOpen(0, 1, 1_000e6);
        h.backerMint(0, 0, 450e18, false);
        h.movePrice(0, 2500);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256 b = backer.sealBatch(sport, ids);
        vm.warp(vm.getBlockTimestamp() + backer.SEAL_DELAY());
        _refreshAll();
        (bool done,) = address(backer).call{gas: minGas / 2}(abi.encodeCall(backer.executeBatch, (b)));
        assertFalse(done, "M-6: low-gas execute must revert");
        assertGt(backer.executeBatch(b), 0, "M-6: batch still executable after the low-gas attempt");
    }

    /// All of R1 to R12 in one campaign: the deep run (script/ci/deep-invariants.sh) targets this one.
    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 50
    /// forge-config: deep.invariant.runs = 250
    /// forge-config: deep.invariant.depth = 200
    function invariant_AllSystem() public view {
        invariant_HoldersExitAboveFloor();
        invariant_HolderBalancesOnlyOwnActions();
        invariant_QuoteEqualsExecution();
        invariant_ExitsNeverGatedByPauses();
        invariant_BooksCovered();
        invariant_HookHoldsNothing();
        invariant_MinterHoldsOnlyEscrow();
        invariant_DebtAndNetConsistent();
        invariant_NfMonotone();
        invariant_ReserveOnlyPaysHolders();
        invariant_DonationsIgnored();
        invariant_DrawdownOnOwnSharePrice();
        invariant_OnlyTimelockUnpauses();
        invariant_FeesConserved();
        invariant_BackerSupplyNeverDrawsReserve();
    }

    /// Coverage evidence per run, one parseable line (script/ci/deep-invariants.sh sums them; shown with -vv).
    function afterInvariant() external {
        string memory line = string.concat(
            "SYSCOV calls=",
            vm.toString(h.totalCalls()),
            " sells=",
            vm.toString(h.callsOf("sell")),
            " sellReverts=",
            vm.toString(h.revertsOf("sell")),
            " buys=",
            vm.toString(h.callsOf("buy")),
            " buyReverts=",
            vm.toString(h.revertsOf("buy")),
            " quoteChecks=",
            vm.toString(h.quoteChecks()),
            " r1Checked=",
            vm.toString(h.r1Checked()),
            " useQueue=",
            vm.toString(h.sellUseQueue())
        );
        line = string.concat(
            line,
            " donations=",
            vm.toString(h.donationChecks()),
            " sealed=",
            vm.toString(h.batchesSealed()),
            " executed=",
            vm.toString(h.batchesExecuted()),
            " liquidated=",
            vm.toString(h.vaultsLiquidated()),
            " reserveDrawn=",
            vm.toString(h.reserveDrawn()),
            " m7Checked=",
            vm.toString(h.m7Checked()),
            " m7BelowZero=",
            vm.toString(h.m7BelowZero()),
            " m7BelowZeroDirect=",
            vm.toString(h.m7BelowZeroDirect()),
            " backerSells=",
            vm.toString(h.backerSells()),
            " backerSellsRefused=",
            vm.toString(h.backerSellsRefused()),
            " pauses=",
            vm.toString(h.guardianPauses()),
            " unpauses=",
            vm.toString(h.timelockUnpauses()),
            " feesPaidOut=",
            vm.toString(h.feesPaidOut())
        );
        console.log(line);
        // one line per run for the deep script to sum (out/ is the only writable path)
        vm.writeLine("out/syscov.txt", line);
    }

    function _str(bytes32 b) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && b[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }
}
