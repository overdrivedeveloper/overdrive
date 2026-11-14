// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BackerFixture, ODBackerHarness} from "./BackerFixture.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {ODMinter} from "overdrive/governor/ODMinter.sol";
import {ODGovernor} from "overdrive/governor/ODGovernor.sol";

/// Backers open, top up, mint (kept or sold), repay (tokens or USDG) and withdraw; holders buy and sell on their
/// own. Ghosts record each holder's balance after the holder's own trades: nothing else may move it (R11).
contract BackerHandler is Test {
    ODBackerHarness internal backer;
    ODMinter internal minter;
    MockUSDG internal usdg;
    bytes32[2] internal gears;
    address[2] internal backers;
    address[2] internal holders;
    uint256[] public vaultIds;
    mapping(address => mapping(bytes32 => uint256)) public ghostHolder;
    uint256 public calls;

    constructor(
        ODBackerHarness b,
        ODMinter m,
        MockUSDG u,
        bytes32[2] memory g,
        address[2] memory bk,
        address[2] memory hd
    ) {
        backer = b;
        minter = m;
        usdg = u;
        gears = g;
        backers = bk;
        holders = hd;
    }

    function vaultCount() external view returns (uint256) {
        return vaultIds.length;
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
        return IERC20(_tokenOf(g));
    }

    function _tokenOf(bytes32 g) internal view returns (address) {
        return address(minter.registry().gear(g).token);
    }

    function open(uint256 seed, uint256 amount) external {
        address who = backers[seed % 2];
        bytes32 g = gears[(seed >> 8) % 2];
        amount = bound(amount, 50e6, 20_000e6);
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(backer), amount);
        vaultIds.push(backer.openVault(g, amount));
        vm.stopPrank();
        ++calls;
    }

    function deposit(uint256 seed, uint256 amount) external {
        (uint256 id,,) = _vault(seed);
        if (id == 0) return;
        amount = bound(amount, 0, 5_000e6);
        address who = holders[seed % 2]; // anyone, even a holder
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(backer), amount);
        backer.deposit(id, amount);
        vm.stopPrank();
        ++calls;
    }

    function mint(uint256 seed, uint256 tokens, bool sell) external {
        (uint256 id, address owner,) = _vault(seed);
        if (id == 0) return;
        tokens = bound(tokens, 1e18, 5_000e18);
        vm.prank(owner);
        try backer.mint(id, tokens, sell, 0) {} catch {}
        ++calls;
    }

    function repay(uint256 seed, uint256 tokens) external {
        (uint256 id, address owner, bytes32 g) = _vault(seed);
        if (id == 0) return;
        uint256 bal = _token(g).balanceOf(owner);
        tokens = bound(tokens, 0, bal);
        vm.prank(owner);
        backer.repay(id, tokens);
        ++calls;
    }

    function repayWithUsdg(uint256 seed, uint256 tokens) external {
        (uint256 id, address owner,) = _vault(seed);
        if (id == 0) return;
        tokens = bound(tokens, 0, 2_000e18);
        vm.prank(owner);
        try backer.repayWithUsdg(id, tokens, type(uint256).max) {} catch {}
        ++calls;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        (uint256 id, address owner,) = _vault(seed);
        if (id == 0) return;
        amount = bound(amount, 0, 10_000e6);
        vm.prank(owner);
        try backer.withdraw(id, amount, owner) {} catch {}
        ++calls;
    }

    function holderBuy(uint256 seed, uint256 usdgIn) external {
        address who = holders[seed % 2];
        bytes32 g = gears[(seed >> 8) % 2];
        usdgIn = bound(usdgIn, 1e6, 5_000e6);
        usdg.mint(who, usdgIn);
        vm.startPrank(who);
        usdg.approve(address(minter), usdgIn);
        try minter.buy(g, usdgIn, 0, who, uint64(block.timestamp)) {} catch {}
        vm.stopPrank();
        ghostHolder[who][g] = _token(g).balanceOf(who);
        ++calls;
    }

    function holderSell(uint256 seed, uint256 bps) external {
        address who = holders[seed % 2];
        bytes32 g = gears[(seed >> 8) % 2];
        uint256 tokens = _token(g).balanceOf(who) * bound(bps, 0, 10_000) / 10_000;
        if (tokens == 0) return;
        vm.prank(who);
        try minter.sell(g, tokens, 0, who, uint64(block.timestamp)) {} catch {}
        ghostHolder[who][g] = _token(g).balanceOf(who);
        ++calls;
    }
}

contract BackerInvariantTest is BackerFixture {
    BackerHandler internal h;
    address internal holder1 = makeAddr("holder1");
    address internal holder2 = makeAddr("holder2");

    function setUp() public override {
        super.setUp();
        h = new BackerHandler(backer, minter, usdg, [sport, cruise], [alice, bob], [holder1, holder2]);
        targetContract(address(h));
    }

    function test_HandlerSmoke() public {
        h.open(0, 1_000e6);
        h.mint(0, 300e18, false);
        h.holderBuy(1, 100e6);
        h.mint(0, 100e18, true);
        h.repay(0, 50e18);
        h.repayWithUsdg(0, 50e18);
        h.withdraw(0, 10e6);
        h.holderSell(1, 5_000);
        assertEq(h.calls(), 8);
        invariant_DebtMatchesGovernor();
        test_NoHolderBalanceChanges();
    }

    /// R10: the Governor's book equals the sum of vault debt, per gear.
    function invariant_DebtMatchesGovernor() public view {
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

    /// R11: holder balances change only by their own trades.
    function test_NoHolderBalanceChanges() public view {
        for (uint256 i; i < 2; ++i) {
            address who = h.holderAt(i);
            for (uint256 gi; gi < 2; ++gi) {
                bytes32 g = h.gearAt(gi);
                assertEq(_token(g).balanceOf(who), h.ghostHolder(who, g));
            }
        }
    }

    function invariant_NoHolderBalanceChanges() public view {
        test_NoHolderBalanceChanges();
    }

    /// VAULT-1: internal accounting is covered by the balance and equals the sum of vault collateral.
    function invariant_CollateralAccounting() public view {
        uint256 sum;
        uint256 n = backer.vaultCount();
        for (uint256 id = 1; id <= n; ++id) {
            (,, uint256 c,,) = backer.vault(id);
            sum += c;
        }
        assertEq(backer.totalCollateral(), sum);
        assertGe(usdg.balanceOf(address(backer)), backer.totalCollateral() + backer.pendingFees());
    }
}
