// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ODTest} from "../utils/ODTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ODAgentRouter} from "overdrive/agent/ODAgentRouter.sol";
import {IODAgentRouter} from "overdrive/interfaces/IODAgentRouter.sol";
import {IODMinter} from "overdrive/interfaces/IODMinter.sol";
import {IODBacker} from "overdrive/interfaces/IODBacker.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";
import {Quote} from "overdrive/interfaces/ODTypes.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockAgentRegistry, MockAgentMinter, MockAgentBacker, MockGearToken} from "../mocks/AgentMocks.sol";

/// Calls back into the router during a buy (stands in for a hostile token or minter hook).
contract ReenteringMinter {
    ODAgentRouter public router;
    address public owner;

    function arm(ODAgentRouter r, address o) external {
        router = r;
        owner = o;
    }

    function buy(bytes32 gearId, uint256 usdgIn, uint256, address, uint64 deadline) external returns (uint256) {
        router.buyFor(owner, gearId, usdgIn, 0, deadline);
        return 0;
    }
}

contract AgentRouterTest is ODTest {
    bytes32 internal constant AAPL = "AAPL";
    bytes32 internal constant MSFT = "MSFT";
    bytes32 internal constant NVDA = "NVDA";
    bytes32 internal constant G_AAPL = keccak256("AAPL-SPORT");
    bytes32 internal constant G_PAIR = keccak256("AAPL/MSFT-SPORT");
    bytes32 internal constant G_NVDA = keccak256("NVDA-SPORT");

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    MockUSDG internal usdg;
    MockAgentRegistry internal registry;
    MockAgentMinter internal minter;
    MockAgentBacker internal backer;
    ODAgentRouter internal router;
    MockGearToken internal tAapl;
    MockGearToken internal tPair;
    MockGearToken internal tNvda;

    uint64 internal deadline;

    function setUp() public {
        vm.warp(1_800_000_000);
        deadline = uint64(block.timestamp + 1 hours);
        usdg = new MockUSDG();
        registry = new MockAgentRegistry();
        minter = new MockAgentMinter(IERC20(address(usdg)), registry);
        backer = new MockAgentBacker(IERC20(address(usdg)));
        router = new ODAgentRouter(
            IERC20(address(usdg)),
            IODMinter(address(minter)),
            IODBacker(address(backer)),
            IODGearRegistry(address(registry))
        );
        tAapl = new MockGearToken("AAPLx2", address(minter), address(backer));
        tPair = new MockGearToken("AAPLMSFTx2", address(minter), address(backer));
        tNvda = new MockGearToken("NVDAx2", address(minter), address(backer));
        registry.set(G_AAPL, AAPL, bytes32(0), address(tAapl));
        registry.set(G_PAIR, AAPL, MSFT, address(tPair));
        registry.set(G_NVDA, NVDA, bytes32(0), address(tNvda));
        usdg.mint(owner, 100_000e6);
        usdg.mint(address(minter), 1_000_000e6); // pays sells
        vm.startPrank(owner);
        usdg.approve(address(router), type(uint256).max);
        backer.setOperator(address(router), true);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------------------------- helpers

    function _markets1(bytes32 a) internal pure returns (bytes32[] memory m) {
        m = new bytes32[](1);
        m[0] = a;
    }

    function _markets2(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory m) {
        m = new bytes32[](2);
        m[0] = a;
        m[1] = b;
    }

    function _policy(uint128 budget, uint128 perTrade, bool canSell, bool canBack, bytes32[] memory markets) internal {
        vm.prank(owner);
        router.setPolicy(agent, budget, perTrade, uint64(block.timestamp + 1 days), canSell, canBack, markets);
    }

    function _defaultPolicy() internal {
        _policy(1_000e6, 300e6, true, true, _markets2(AAPL, MSFT));
    }

    function _buy(bytes32 gearId, uint256 usdgIn) internal returns (uint256) {
        vm.prank(agent);
        return router.buyFor(owner, gearId, usdgIn, 0, deadline);
    }

    function _assertRouterEmpty() internal view {
        assertEq(usdg.balanceOf(address(router)), 0, "router USDG");
        assertEq(tAapl.balanceOf(address(router)), 0, "router AAPL token");
        assertEq(tPair.balanceOf(address(router)), 0, "router pair token");
        assertEq(tNvda.balanceOf(address(router)), 0, "router NVDA token");
    }

    // -------------------------------------------------------------------------------------------- R1

    function test_OnlyOwnerSetsPolicy() public {
        _defaultPolicy();
        // The agent setting a policy writes under ITS OWN address, never the owner's.
        vm.prank(agent);
        router.setPolicy(stranger, 1e30, 1e30, type(uint64).max, true, true, _markets1(NVDA));
        IODAgentRouter.Policy memory p = router.policyOf(owner, agent);
        assertEq(p.budgetUsdg, 1_000e6);
        assertEq(router.policyOf(agent, stranger).budgetUsdg, 1e30);
        assertFalse(router.isAllowedMarket(owner, agent, NVDA));
        // The stranger's policy from the agent cannot spend the owner's USDG.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.NoPolicy.selector, owner, stranger));
        router.buyFor(owner, G_NVDA, 10e6, 0, deadline);
        // Self and zero agents are refused.
        vm.prank(owner);
        vm.expectRevert(ODAgentRouter.InvalidPolicy.selector);
        router.setPolicy(owner, 1, 1, uint64(block.timestamp + 1), false, false, _markets1(AAPL));
        vm.prank(owner);
        vm.expectRevert(ODAgentRouter.InvalidPolicy.selector);
        router.setPolicy(address(0), 1, 1, uint64(block.timestamp + 1), false, false, _markets1(AAPL));
    }

    function test_RevokeNoExternalCall() public {
        _defaultPolicy();
        // Every dependency broken: revoke still works because it calls nothing.
        vm.etch(address(minter), hex"fe");
        vm.etch(address(backer), hex"fe");
        vm.etch(address(registry), hex"fe");
        vm.etch(address(usdg), hex"fe");
        vm.record();
        vm.prank(owner);
        router.revoke(agent);
        (, bytes32[] memory writes) = vm.accesses(address(router));
        assertEq(writes.length, 1, "one storage write");
        assertTrue(router.policyOf(owner, agent).revoked);
    }

    function test_PairNeedsBothMarkets() public {
        _policy(1_000e6, 300e6, false, false, _markets1(AAPL));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.MarketNotAllowed.selector, MSFT));
        router.buyFor(owner, G_PAIR, 10e6, 0, deadline);
        _policy(1_000e6, 300e6, false, false, _markets1(MSFT));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.MarketNotAllowed.selector, AAPL));
        router.buyFor(owner, G_PAIR, 10e6, 0, deadline);
        _policy(1_000e6, 300e6, false, false, _markets2(MSFT, AAPL));
        assertGt(_buy(G_PAIR, 10e6), 0);
        assertGt(tPair.balanceOf(owner), 0);
    }

    function test_NewPolicyReplacesMarketList() public {
        _policy(1_000e6, 300e6, false, false, _markets2(AAPL, AAPL));
        assertEq(router.allowedMarkets(owner, agent).length, 1, "duplicate dropped");
        _policy(1_000e6, 300e6, false, false, _markets1(NVDA));
        assertFalse(router.isAllowedMarket(owner, agent, AAPL));
        assertTrue(router.isAllowedMarket(owner, agent, NVDA));
        bytes32[] memory list = router.allowedMarkets(owner, agent);
        assertEq(list.length, 1);
        assertEq(list[0], NVDA);
    }

    // -------------------------------------------------------------------------------------------- R2

    function test_BuyForRecipientIsOwner() public {
        _defaultPolicy();
        uint256 before = usdg.balanceOf(owner);
        uint256 out = _buy(G_AAPL, 100e6);
        assertEq(tAapl.balanceOf(owner), out);
        assertEq(tAapl.balanceOf(agent), 0);
        assertEq(usdg.balanceOf(owner), before - 100e6);
        assertEq(router.policyOf(owner, agent).spentUsdg, 100e6);
        _assertRouterEmpty();
    }

    function test_BudgetLifetime() public {
        _policy(250e6, 200e6, false, false, _markets1(AAPL));
        _buy(G_AAPL, 200e6);
        assertEq(router.remainingBudget(owner, agent), 50e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.BudgetExceeded.selector, 200e6, 60e6, 250e6));
        router.buyFor(owner, G_AAPL, 60e6, 0, deadline);
        _buy(G_AAPL, 50e6);
        assertEq(router.remainingBudget(owner, agent), 0);
        // Re-setting the policy keeps the lifetime spend and clears a revoke.
        vm.prank(owner);
        router.revoke(agent);
        _policy(300e6, 200e6, false, false, _markets1(AAPL));
        IODAgentRouter.Policy memory p = router.policyOf(owner, agent);
        assertEq(p.spentUsdg, 250e6);
        assertFalse(p.revoked);
        assertEq(router.remainingBudget(owner, agent), 50e6);
    }

    function test_MaxPerTrade() public {
        _policy(1_000e6, 100e6, false, false, _markets1(AAPL));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.MaxPerTradeExceeded.selector, 100e6 + 1, 100e6));
        router.buyFor(owner, G_AAPL, 100e6 + 1, 0, deadline);
        _buy(G_AAPL, 100e6);
    }

    function test_Expired() public {
        _defaultPolicy();
        uint64 exp = router.policyOf(owner, agent).expiresAt;
        vm.warp(exp);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.PolicyExpired.selector, exp));
        router.buyFor(owner, G_AAPL, 10e6, 0, uint64(block.timestamp + 1));
    }

    function test_Revoked() public {
        _defaultPolicy();
        _buy(G_AAPL, 10e6);
        vm.prank(owner);
        router.revoke(agent);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.PolicyIsRevoked.selector, owner, agent));
        router.buyFor(owner, G_AAPL, 10e6, 0, deadline);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.PolicyIsRevoked.selector, owner, agent));
        router.sellFor(owner, G_AAPL, 1, 0, deadline);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.PolicyIsRevoked.selector, owner, agent));
        router.backFor(owner, 0, G_AAPL, 50e6, 0, 0, deadline);
    }

    function test_MarketNotAllowed() public {
        _defaultPolicy();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.MarketNotAllowed.selector, NVDA));
        router.buyFor(owner, G_NVDA, 10e6, 0, deadline);
    }

    function test_BuyNeedsOwnerApproval() public {
        _defaultPolicy();
        vm.prank(owner);
        usdg.approve(address(router), 0);
        vm.prank(agent);
        vm.expectRevert();
        router.buyFor(owner, G_AAPL, 10e6, 0, deadline);
        assertEq(router.policyOf(owner, agent).spentUsdg, 0, "failed call books nothing");
    }

    function test_Reentrancy() public {
        ReenteringMinter evil = new ReenteringMinter();
        ODAgentRouter r = new ODAgentRouter(
            IERC20(address(usdg)),
            IODMinter(address(evil)),
            IODBacker(address(backer)),
            IODGearRegistry(address(registry))
        );
        evil.arm(r, owner);
        vm.startPrank(owner);
        usdg.approve(address(r), type(uint256).max);
        r.setPolicy(agent, 1_000e6, 300e6, uint64(block.timestamp + 1 days), false, false, _markets1(AAPL));
        r.setPolicy(address(evil), 1_000e6, 300e6, uint64(block.timestamp + 1 days), false, false, _markets1(AAPL));
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r.buyFor(owner, G_AAPL, 10e6, 0, deadline);
    }

    // -------------------------------------------------------------------------------------------- R3

    function test_SellForProceedsToOwner() public {
        _defaultPolicy();
        uint256 tokens = _buy(G_AAPL, 200e6);
        vm.prank(owner);
        tAapl.approve(address(router), tokens);
        uint256 usdgBefore = usdg.balanceOf(owner);
        uint256 agentBefore = usdg.balanceOf(agent);
        vm.prank(agent);
        uint256 out = router.sellFor(owner, G_AAPL, tokens, 1, deadline);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(owner), usdgBefore + out);
        assertEq(usdg.balanceOf(agent), agentBefore);
        assertEq(tAapl.balanceOf(owner), 0);
        assertEq(router.policyOf(owner, agent).spentUsdg, 200e6 + out, "L-4: the sell is charged its USDG value");
        _assertRouterEmpty();
    }

    function test_SellNeedsCanSell() public {
        _policy(1_000e6, 300e6, false, true, _markets1(AAPL));
        vm.prank(agent);
        vm.expectRevert(IODAgentRouter.SellNotAllowed.selector);
        router.sellFor(owner, G_AAPL, 1, 0, deadline);
    }

    function test_SellNeedsOwnerTokenApproval() public {
        _defaultPolicy();
        uint256 tokens = _buy(G_AAPL, 50e6);
        vm.prank(agent);
        vm.expectRevert();
        router.sellFor(owner, G_AAPL, tokens, 0, deadline);
        // A stranger's tokens sent to the router never let an agent sell them.
        assertEq(tAapl.balanceOf(owner), tokens);
    }

    function test_UseQueueBubbles() public {
        _defaultPolicy();
        uint256 tokens = _buy(G_AAPL, 50e6);
        vm.prank(owner);
        tAapl.approve(address(router), tokens);
        minter.setUseQueue(true);
        vm.prank(agent);
        vm.expectRevert(IODMinter.UseQueue.selector);
        router.sellFor(owner, G_AAPL, tokens, 0, deadline);
        assertEq(tAapl.balanceOf(owner), tokens, "owner keeps the tokens");
    }

    // -------------------------------------------------------------------------------------------- R4

    function test_BackForVaultOwnedByOwner() public {
        _defaultPolicy();
        vm.prank(agent);
        (uint256 id, uint256 proceeds) = router.backFor(owner, 0, G_AAPL, 100e6, 2e18, 1, deadline);
        (address vOwner, bytes32 vGear, uint256 coll, uint256 debt,) = backer.vault(id);
        assertEq(vOwner, owner);
        assertEq(vGear, G_AAPL);
        assertEq(debt, 2e18);
        assertEq(proceeds, 20e6);
        assertEq(coll, 100e6 + proceeds, "proceeds stay as vault collateral");
        assertEq(usdg.balanceOf(agent), 0);
        // Top up the same vault and mint more.
        vm.prank(agent);
        (uint256 id2,) = router.backFor(owner, id, G_AAPL, 50e6, 1e18, 0, deadline);
        assertEq(id2, id);
        (,, coll,,) = backer.vault(id);
        assertEq(coll, 100e6 + 20e6 + 50e6 + 10e6);
        _assertRouterEmpty();
    }

    function test_BackForRefusesOthersVault() public {
        _defaultPolicy();
        usdg.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdg.approve(address(backer), 100e6);
        uint256 theirs = backer.openVault(G_AAPL, 100e6);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotVaultOwner.selector, theirs));
        router.backFor(owner, theirs, G_AAPL, 50e6, 0, 0, deadline);
        // A vault of the owner on another gear is refused too.
        vm.prank(agent);
        (uint256 mine,) = router.backFor(owner, 0, G_AAPL, 50e6, 0, 0, deadline);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ODAgentRouter.VaultGearMismatch.selector, mine, G_PAIR));
        router.backFor(owner, mine, G_PAIR, 50e6, 0, 0, deadline);
    }

    function test_BackNeedsCanBack() public {
        _policy(1_000e6, 300e6, true, false, _markets1(AAPL));
        vm.prank(agent);
        vm.expectRevert(IODAgentRouter.BackNotAllowed.selector);
        router.backFor(owner, 0, G_AAPL, 100e6, 0, 0, deadline);
    }

    function test_BackNeedsOperatorApproval() public {
        _defaultPolicy();
        vm.prank(owner);
        backer.setOperator(address(router), false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODBacker.NotOperator.selector, owner, address(router)));
        router.backFor(owner, 0, G_AAPL, 100e6, 1e18, 0, deadline);
    }

    function test_BackCountsBudget() public {
        _policy(150e6, 100e6, false, true, _markets1(AAPL));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.MaxPerTradeExceeded.selector, 101e6, 100e6));
        router.backFor(owner, 0, G_AAPL, 101e6, 0, 0, deadline);
        vm.prank(agent);
        router.backFor(owner, 0, G_AAPL, 100e6, 0, 0, deadline);
        assertEq(router.policyOf(owner, agent).spentUsdg, 100e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.BudgetExceeded.selector, 100e6, 60e6, 150e6));
        router.backFor(owner, 0, G_AAPL, 60e6, 0, 0, deadline);
    }

    /// L-4 (audit): sellFor charged nothing, so an agent with canSell could sell the owner's whole approved balance
    /// past the per-trade cap and the budget. Now the sell's USDG value is charged.
    function test_L4_SellChargedAgainstCapAndBudget() public {
        _policy(1_000e6, 300e6, true, false, _markets1(AAPL));
        uint256 tokens = _buy(G_AAPL, 300e6);
        tokens += _buy(G_AAPL, 300e6);
        vm.prank(owner);
        tAapl.approve(address(router), type(uint256).max);
        // the whole balance (about 600 USDG) is over the 300 per-trade cap
        vm.prank(agent);
        vm.expectRevert();
        router.sellFor(owner, G_AAPL, tokens, 0, deadline);
        // half of it fits the cap, but 600 spent + about 300 left of 1,000 budget: the second half is over budget
        vm.prank(agent);
        uint256 out = router.sellFor(owner, G_AAPL, tokens / 2, 0, deadline);
        assertEq(router.policyOf(owner, agent).spentUsdg, 600e6 + out);
        vm.prank(agent);
        vm.expectRevert();
        router.sellFor(owner, G_AAPL, tokens - tokens / 2, 0, deadline);
        _assertRouterEmpty();
    }

    /// L-4 (audit): backFor with collateralUsdg = 0 charged 0 and could mint an existing vault down to the minimum
    /// ratio. Now the minted debt (its sale proceeds) is charged too.
    function test_L4_BackerMintCharged() public {
        _policy(150e6, 100e6, false, true, _markets1(AAPL));
        vm.prank(agent);
        (uint256 id, uint256 p1) = router.backFor(owner, 0, G_AAPL, 50e6, 2e18, 0, deadline);
        assertEq(router.policyOf(owner, agent).spentUsdg, 50e6 + p1);
        vm.prank(agent);
        (, uint256 p2) = router.backFor(owner, id, G_AAPL, 0, 1e18, 0, deadline);
        assertGt(p2, 0);
        assertEq(router.policyOf(owner, agent).spentUsdg, 50e6 + p1 + p2, "a mint with no collateral is charged");
        // a mint worth more than the per-trade cap reverts
        vm.prank(agent);
        vm.expectRevert();
        router.backFor(owner, id, G_AAPL, 0, 11e18, 0, deadline);
    }

    /// Property: whatever the agent does, spentUsdg equals the USDG it moved (buys in, sells out, collateral plus
    /// mint proceeds) and never exceeds the budget.
    function testFuzz_L4_BudgetCoversEveryAction(uint256 seed, uint128 budget, uint128 perTrade) public {
        budget = uint128(bound(budget, 1e6, 5_000e6));
        perTrade = uint128(bound(perTrade, 1e6, budget));
        _policy(budget, perTrade, true, true, _markets1(AAPL));
        vm.prank(owner);
        tAapl.approve(address(router), type(uint256).max);
        uint256 vaultId;
        uint256 moved;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = seed % 3;
            uint256 amt = bound(seed >> 8, 1, uint256(perTrade) * 2);
            vm.prank(agent);
            if (action == 0) {
                try router.buyFor(owner, G_AAPL, amt, 0, deadline) {
                    moved += amt;
                } catch {}
            } else if (action == 1) {
                uint256 bal = tAapl.balanceOf(owner);
                if (bal == 0) continue;
                try router.sellFor(owner, G_AAPL, bound(amt, 1, bal), 0, deadline) returns (uint256 out) {
                    moved += out;
                } catch {}
            } else {
                uint256 c = (seed >> 100) % 2 == 0 ? 0 : amt;
                try router.backFor(owner, vaultId, G_AAPL, vaultId == 0 ? amt : c, amt * 1e10, 0, deadline) returns (
                    uint256 id, uint256 pr
                ) {
                    moved += (vaultId == 0 ? amt : c) + pr;
                    vaultId = id;
                } catch {}
            }
            assertEq(router.policyOf(owner, agent).spentUsdg, moved, "every action charged");
            assertLe(moved, budget);
        }
    }

    // -------------------------------------------------------------------------------------------- R5

    function test_QuoteLimitPassesThroughRouter() public {
        _defaultPolicy();
        minter.setToll(1e12); // toll due: value falls every second
        vm.warp(block.timestamp + 3 hours);
        deadline = uint64(block.timestamp + 1 hours);
        Quote memory q = minter.quote(G_AAPL, true, true, 123_456_789);
        assertGt(q.protocolFeeUsdg, 0, "fees on");
        vm.prank(agent);
        uint256 out = router.buyFor(owner, G_AAPL, 123_456_789, q.amountOut, deadline);
        assertEq(out, q.amountOut);
        // One wei more than the quote fails with the minter's slippage error.
        vm.warp(block.timestamp + 1 hours);
        deadline = uint64(block.timestamp + 1 hours);
        q = minter.quote(G_AAPL, true, true, 10e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IODMinter.Slippage.selector, q.amountOut, q.amountOut + 1));
        router.buyFor(owner, G_AAPL, 10e6, q.amountOut + 1, deadline);
    }

    // -------------------------------------------------------------------------------------------- R6

    function test_StrangerNoPolicy() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.NoPolicy.selector, owner, stranger));
        router.buyFor(owner, G_AAPL, 10e6, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.NoPolicy.selector, owner, stranger));
        router.sellFor(owner, G_AAPL, 1, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.NoPolicy.selector, owner, stranger));
        router.backFor(owner, 0, G_AAPL, 50e6, 0, 0, deadline);
        vm.stopPrank();
        // Another owner's agent has no policy for this owner either.
        _defaultPolicy();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IODAgentRouter.NoPolicy.selector, owner, stranger));
        router.buyFor(owner, G_AAPL, 10e6, 0, deadline);
    }

    /// Fuzzed sequences of buys, sells and backs: the router never keeps a token, the budget is never exceeded, and
    /// everything bought lands with the owner.
    function testFuzz_RouterBalanceZero(uint256 seed, uint128 budget, uint128 perTrade) public {
        budget = uint128(bound(budget, 1e6, 5_000e6));
        perTrade = uint128(bound(perTrade, 1e6, budget));
        _policy(budget, perTrade, true, true, _markets2(AAPL, MSFT));
        vm.prank(owner);
        tAapl.approve(address(router), type(uint256).max);
        uint256 vaultId;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = seed % 3;
            uint256 amt = bound(seed >> 8, 1, uint256(perTrade) * 2);
            vm.prank(agent);
            if (action == 0) {
                try router.buyFor(owner, (seed >> 200) % 2 == 0 ? G_AAPL : G_PAIR, amt, 0, deadline) {} catch {}
            } else if (action == 1) {
                uint256 bal = tAapl.balanceOf(owner);
                if (bal == 0) continue;
                try router.sellFor(owner, G_AAPL, bound(amt, 1, bal), 0, deadline) {} catch {}
            } else {
                try router.backFor(owner, vaultId, G_AAPL, amt, amt * 1e10, 0, deadline) returns (uint256 id, uint256) {
                    vaultId = id;
                } catch {}
            }
            _assertRouterEmpty();
            assertLe(router.policyOf(owner, agent).spentUsdg, budget);
        }
    }

    function test_EventShape() public {
        _defaultPolicy();
        vm.expectEmit(true, true, true, true, address(router));
        emit IODAgentRouter.AgentTrade(owner, agent, G_AAPL, "BUY", 10e6);
        _buy(G_AAPL, 10e6);
    }
}
