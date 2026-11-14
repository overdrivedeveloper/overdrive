// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GovernorFixture, GovGuard} from "./GovernorFixture.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockMinterForGovernor} from "../mocks/MockMinterForGovernor.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";
import {ODInsurance} from "overdrive/governor/ODInsurance.sol";
import {Gear} from "overdrive/interfaces/ODTypes.sol";

/// Random flows against the Governor: deposits, buys, sells (with free cash drained), tolls, reserve moves, donations,
/// hedger moves, withdrawals and price moves.
contract GovHandler is Test {
    ODGovernor internal gov;
    MockUSDG internal usdg;
    MockMinterForGovernor internal minter;
    GovGuard internal guard;
    ODInsurance internal ins;
    bytes32[] internal ids;
    address internal lp;
    address internal keeper;
    address internal hedger;
    address internal hedgeWallet;
    address internal alice = address(0xA11CE);
    uint256[] internal tickets;

    uint256 public reserveFloorViolations;
    uint256 public sellsChecked;

    constructor(
        ODGovernor g,
        MockUSDG u,
        MockMinterForGovernor m,
        GovGuard gd,
        ODInsurance i,
        bytes32[] memory ids_,
        address[4] memory roles
    ) {
        gov = g;
        usdg = u;
        minter = m;
        guard = gd;
        ins = i;
        ids = ids_;
        lp = roles[0];
        keeper = roles[1];
        hedger = roles[2];
        hedgeWallet = roles[3];
    }

    function deposit(uint256 a) external {
        a = bound(a, 1e6, 100_000e6);
        usdg.mint(lp, a);
        vm.startPrank(lp);
        usdg.approve(address(gov), a);
        try gov.deposit(a, lp) {} catch {}
        vm.stopPrank();
    }

    function buy(uint256 gi, uint256 tokens) external {
        bytes32 id = ids[gi % ids.length];
        tokens = bound(tokens, 1e18, 20_000e18);
        uint256 usdgIn = tokens / 1e12;
        usdg.mint(alice, usdgIn);
        vm.prank(alice);
        usdg.approve(address(minter), usdgIn);
        try minter.buy(id, alice, alice, tokens, usdgIn, usdgIn / 100) {} catch {}
    }

    /// R7: drain free cash first, then sell at a random size; with the reserve at or above its floor and the proceeds
    /// within the reserve, the payout must succeed.
    function sellDrained(uint256 gi, uint256 frac, uint256 proceeds) external {
        bytes32 id = ids[gi % ids.length];
        IERC20 tok = IERC20(_token(id));
        uint256 bal = tok.balanceOf(alice);
        if (bal == 0) return;
        uint256 tokens = bound(frac, 1, bal);
        uint256 cash = gov.freeCash();
        if (cash != 0) {
            vm.prank(keeper);
            gov.moveToExitReserve(cash);
        }
        uint256 reserve = gov.exitReserve();
        proceeds = bound(proceeds, 0, reserve + 1_000e6);
        bool aboveFloor = reserve >= gov.exitReserveFloor();
        bool paid = minter.sell(id, alice, alice, tokens, proceeds, 0);
        if (aboveFloor && proceeds <= reserve) {
            ++sellsChecked;
            if (!paid) ++reserveFloorViolations;
        }
    }

    function toll(uint256 gi, int256 v) external {
        v = bound(v, -10_000e18, 10_000e18);
        minter.toll(ids[gi % ids.length], v);
    }

    function fundReserve(uint256 a) external {
        a = bound(a, 0, 50_000e6);
        usdg.mint(address(this), a);
        usdg.approve(address(gov), a);
        gov.fundExitReserve(a);
    }

    function fundCash(uint256 a) external {
        a = bound(a, 0, 50_000e6);
        usdg.mint(address(this), a);
        usdg.approve(address(gov), a);
        gov.fundCash(a);
    }

    function donate(uint256 a) external {
        usdg.mint(address(gov), bound(a, 0, 1_000_000e6));
    }

    function hedgeOut(uint256 a) external {
        a = bound(a, 0, gov.freeCash());
        vm.prank(hedger);
        try gov.sendToHedger(a) {} catch {}
    }

    function hedgeBack(uint256 a) external {
        a = bound(a, 0, usdg.balanceOf(hedgeWallet));
        vm.prank(hedgeWallet);
        usdg.transfer(hedger, a);
        vm.startPrank(hedger);
        usdg.approve(address(gov), a);
        gov.returnFromHedger(a);
        vm.stopPrank();
    }

    function requestAndClaim(uint256 frac) external {
        uint256 s = gov.balanceOf(lp);
        if (s != 0) {
            vm.prank(lp);
            tickets.push(gov.requestWithdraw(bound(frac, 1, s)));
        }
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        gov.pokeRisk(new bytes32[](0));
        for (uint256 i; i < tickets.length; ++i) {
            vm.prank(lp);
            gov.claim(tickets[i], 0);
        }
    }

    function movePrice(uint256 p) external {
        p = bound(p, 150e18, 400e18);
        guard.set("TSLA", p, p);
        gov.pokeRisk(new bytes32[](0));
    }

    function _token(bytes32 id) internal view returns (address t) {
        (bool ok, bytes memory d) = address(gov.registry()).staticcall(abi.encodeWithSignature("gear(bytes32)", id));
        require(ok);
        // GearConfig: marketA, marketB, gear, token, ...
        assembly {
            t := mload(add(d, 128))
        }
    }
}

contract GovernorInvariantTest is GovernorFixture {
    GovHandler internal h;

    function setUp() public override {
        super.setUp();
        _deposit(lp, 200_000e6);
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = _list(TSLA, NONE, Gear.SPORT, 1_000_000e18);
        ids[1] = _list(TSLA, NONE, Gear.ECO, 1_000_000e18);
        ids[2] = _list(TSLA, NONE, Gear.REVERSE, 1_000_000e18);
        h = new GovHandler(gov, usdg, minter, guard, ins, ids, [lp, keeper, hedger, hedgeWallet]);
        // Holders start with gears, so drained-cash sells happen from the first call.
        address holder = address(0xA11CE);
        usdg.mint(holder, 30_000e6);
        vm.prank(holder);
        usdg.approve(address(minter), 30_000e6);
        for (uint256 i; i < 3; ++i) {
            minter.buy(ids[i], holder, holder, 10_000e18, 10_000e6, 0);
        }
        targetContract(address(h));
    }

    function test_HandlerChecksSells() public {
        h.fundReserve(5_000e6);
        h.sellDrained(0, 100e18, 50e6);
        assertEq(h.sellsChecked(), 1);
        assertEq(h.reserveFloorViolations(), 0);
    }

    function invariant_BalanceCoversBooks() public view {
        assertGe(usdg.balanceOf(address(gov)), gov.freeCash() + gov.exitReserve());
    }

    function invariant_ReserveAboveFloorPaysSells() public view {
        assertEq(h.reserveFloorViolations(), 0);
    }
}
