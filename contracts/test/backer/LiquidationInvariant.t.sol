// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackerFixture, ODBackerHarness} from "./BackerFixture.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";

interface IWalk {
    function walk(int256 bps) external;
}

/// Holders trade, backers open, mint, repay and top up, the price walks, a liquidator seals and executes batches.
/// Ghosts record each holder's balance after the holder's own trades: no liquidation may move it (R8).
contract LiquidationHandler is Test {
    ODBackerHarness internal backer;
    ODMinter internal minter;
    MockUSDG internal usdg;
    IWalk internal world;
    bytes32[2] internal gears;
    address[2] internal backers;
    address[2] internal holders;
    address internal keeper = makeAddr("keeper");
    uint256[] public vaultIds;
    uint256[] internal pending;
    mapping(address => mapping(bytes32 => uint256)) public ghostHolder;
    uint256 public liquidations;

    constructor(
        ODBackerHarness b,
        ODMinter m,
        MockUSDG u,
        IWalk w,
        bytes32[2] memory g,
        address[2] memory bk,
        address[2] memory hd
    ) {
        (backer, minter, usdg, world, gears, backers, holders) = (b, m, u, w, g, bk, hd);
    }

    function gearAt(uint256 i) external view returns (bytes32) {
        return gears[i];
    }

    function holderAt(uint256 i) external view returns (address) {
        return holders[i];
    }

    function _vault(uint256 seed) internal view returns (uint256 id, address owner, bytes32 g) {
        if (vaultIds.length == 0) return (0, address(0), 0);
        id = vaultIds[seed % vaultIds.length];
        (owner, g,,,) = backer.vault(id);
    }

    function _token(bytes32 g) internal view returns (IERC20) {
        return IERC20(address(minter.registry().gear(g).token));
    }

    function open(uint256 seed, uint256 amount, uint256 tokens) external {
        address who = backers[seed % 2];
        bytes32 g = gears[(seed >> 8) % 2];
        amount = bound(amount, 50e6, 5_000e6);
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(backer), amount);
        uint256 id = backer.openVault(g, amount);
        tokens = bound(tokens, 1e18, 4_000e18);
        try backer.mint(id, tokens, seed % 3 == 0, 0) {} catch {}
        vm.stopPrank();
        vaultIds.push(id);
    }

    function deposit(uint256 seed, uint256 amount) external {
        (uint256 id,,) = _vault(seed);
        if (id == 0) return;
        amount = bound(amount, 0, 2_000e6);
        usdg.mint(address(this), amount);
        usdg.approve(address(backer), amount);
        backer.deposit(id, amount);
    }

    function repay(uint256 seed, uint256 bps) external {
        (uint256 id, address owner, bytes32 g) = _vault(seed);
        if (id == 0) return;
        uint256 tokens = _token(g).balanceOf(owner) * bound(bps, 0, 10_000) / 10_000;
        vm.prank(owner);
        backer.repay(id, tokens);
    }

    function holderBuy(uint256 seed, uint256 usdgIn) external {
        address who = holders[seed % 2];
        bytes32 g = gears[(seed >> 8) % 2];
        usdgIn = bound(usdgIn, 1e6, 3_000e6);
        usdg.mint(who, usdgIn);
        vm.startPrank(who);
        usdg.approve(address(minter), usdgIn);
        try minter.buy(g, usdgIn, 0, who, uint64(block.timestamp)) {} catch {}
        vm.stopPrank();
        ghostHolder[who][g] = _token(g).balanceOf(who);
    }

    function holderSell(uint256 seed, uint256 bps) external {
        address who = holders[seed % 2];
        bytes32 g = gears[(seed >> 8) % 2];
        uint256 tokens = _token(g).balanceOf(who) * bound(bps, 0, 10_000) / 10_000;
        if (tokens == 0) return;
        vm.prank(who);
        try minter.sell(g, tokens, 0, who, uint64(block.timestamp)) {} catch {}
        ghostHolder[who][g] = _token(g).balanceOf(who);
    }

    function walk(int256 bps) external {
        world.walk(int256(bound(bps, -1_500, 2_500)));
    }

    function seal(uint256 seed) external {
        bytes32 g = gears[seed % 2];
        uint256 n = vaultIds.length;
        if (n == 0) return;
        if (n > 50) n = 50;
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = vaultIds[vaultIds.length - 1 - i];
        }
        vm.prank(keeper);
        try backer.sealBatch(g, ids) returns (uint256 b) {
            pending.push(b);
        } catch {}
    }

    function execute(uint256 dt) external {
        world.walk(0); // time passes, inputs refreshed at the same price
        vm.warp(block.timestamp + bound(dt, 0, 120));
        world.walk(0);
        for (uint256 i; i < pending.length; ++i) {
            vm.prank(keeper);
            try backer.executeBatch(pending[i]) returns (uint256 n) {
                liquidations += n;
            } catch {}
        }
        delete pending;
    }
}

contract LiquidationInvariantTest is BackerFixture, IWalk {
    LiquidationHandler internal h;
    address internal holder1 = makeAddr("holder1");
    address internal holder2 = makeAddr("holder2");

    function setUp() public override {
        super.setUp();
        h = new LiquidationHandler(backer, minter, usdg, this, [sport, cruise], [alice, bob], [holder1, holder2]);
        targetContract(address(h));
    }

    /// The price walk (both TSLA gears follow it), keeping every input fresh. Stays inside the continuity band.
    function walk(int256 bps) external {
        uint256 p = _p(TSLA);
        uint256 next = uint256(int256(p) + int256(p) * bps / 10_000);
        if (next < 50e18) next = 50e18;
        if (next > 1_000e18) next = 1_000e18;
        _price(TSLA, next);
        _refreshAll();
    }

    function test_HandlerSmoke() public {
        h.open(1, 1_000e6, 500e18); // sport, kept tokens, 200%
        h.open(2, 1_000e6, 500e18);
        h.holderBuy(1, 500e6);
        h.walk(2_000); // value x 1.44: under maintenance
        h.seal(0);
        h.execute(31);
        assertGt(h.liquidations(), 0, "a liquidation happened");
        invariant_HoldersUntouched();
        invariant_DebtMatches();
        invariant_CollateralConserved();
    }

    /// Holder balances change only through their own trades.
    function invariant_HoldersUntouched() public view {
        for (uint256 i; i < 2; ++i) {
            address who = h.holderAt(i);
            for (uint256 gi; gi < 2; ++gi) {
                bytes32 g = h.gearAt(gi);
                assertEq(_token(g).balanceOf(who), h.ghostHolder(who, g));
            }
        }
    }

    /// governor.backerDebt == sum of vault debt, per gear, through every liquidation.
    function invariant_DebtMatches() public view {
        for (uint256 gi; gi < 2; ++gi) {
            bytes32 g = h.gearAt(gi);
            uint256 sum;
            uint256 n = backer.vaultCount();
            for (uint256 id = 1; id <= n; ++id) {
                (, bytes32 vg,, uint256 d,) = backer.vault(id);
                if (vg == g) sum += d;
            }
            assertEq(ODGovernor(address(gov)).backerDebt(g), sum);
        }
    }

    /// Every USDG that entered (deposits, sale proceeds, cover) is either vault collateral, a pending toll fee, or left
    /// (fees sent, withdrawals, liquidation payouts): the backer's balance equals the sum of vault collateral plus the
    /// pending fees exactly, and the books agree with the vaults.
    function invariant_CollateralConserved() public view {
        uint256 sum;
        uint256 n = backer.vaultCount();
        for (uint256 id = 1; id <= n; ++id) {
            (,, uint256 c,,) = backer.vault(id);
            sum += c;
        }
        assertEq(backer.totalCollateral(), sum);
        // I6-1: sale credit is collateral the Governor holds
        assertEq(usdg.balanceOf(address(backer)) + backer.totalHeld(), backer.totalCollateral() + backer.pendingFees());
        assertEq(gov.saleCredit(), backer.totalHeld());
    }
}
