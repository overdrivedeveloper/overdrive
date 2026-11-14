// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IODAgentRouter} from "../interfaces/IODAgentRouter.sol";
import {IODMinter} from "../interfaces/IODMinter.sol";
import {IODBacker} from "../interfaces/IODBacker.sol";
import {IODGearRegistry} from "../interfaces/IODGearRegistry.sol";
import {GearConfig} from "../interfaces/ODTypes.sol";

/// @title ODAgentRouter
/// @notice Lets an agent key buy, sell and back for an owner inside the owner's on-chain policy. No admin, no pause,
/// no upgrade: the owner's `revoke` is the stop, and every minter and backer pause applies through it. The router
/// holds no funds between calls: USDG pulled for a buy is spent by the minter in the same call, gear tokens are minted
/// straight to the owner, sale proceeds are paid straight to the owner, and backing collateral goes into a vault the
/// owner owns.
contract ODAgentRouter is ReentrancyGuardTransient, IODAgentRouter {
    using SafeERC20 for IERC20;

    bytes32 private constant ACTION_BUY = "BUY";
    bytes32 private constant ACTION_SELL = "SELL";
    bytes32 private constant ACTION_BACK = "BACK";

    IERC20 public immutable USDG;
    IODMinter public immutable MINTER;
    IODBacker public immutable BACKER;
    IODGearRegistry public immutable REGISTRY;

    mapping(address owner => mapping(address agent => Policy)) private _policies;
    /// @dev A market is allowed when its stamp equals the policy's current generation (setPolicy bumps it, so an old
    /// list is cleared without a loop).
    mapping(address owner => mapping(address agent => uint256)) private _generation;
    mapping(address owner => mapping(address agent => mapping(bytes32 market => uint256))) private _allowedAt;
    mapping(address owner => mapping(address agent => bytes32[])) private _markets;

    error InvalidPolicy();
    error ZeroAddress();
    error VaultGearMismatch(uint256 vaultId, bytes32 gearId);
    error RouterKeptFunds();

    constructor(IERC20 usdg, IODMinter minter, IODBacker backer, IODGearRegistry registry) {
        if (
            address(usdg) == address(0) || address(minter) == address(0) || address(backer) == address(0)
                || address(registry) == address(0)
        ) revert ZeroAddress();
        USDG = usdg;
        MINTER = minter;
        BACKER = backer;
        REGISTRY = registry;
    }

    // ------------------------------------------------------------------------------------------------- owner

    /// @inheritdoc IODAgentRouter
    function setPolicy(
        address agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canBack,
        bytes32[] calldata markets
    ) external {
        if (agent == address(0) || agent == msg.sender) revert InvalidPolicy();
        Policy storage p = _policies[msg.sender][agent];
        p.agent = agent;
        p.budgetUsdg = budgetUsdg;
        p.maxPerTradeUsdg = maxPerTradeUsdg;
        p.expiresAt = expiresAt;
        p.canSell = canSell;
        p.canBack = canBack;
        p.revoked = false;
        // spentUsdg is lifetime: a new policy for the same agent keeps what it already spent.

        uint256 gen = ++_generation[msg.sender][agent];
        mapping(bytes32 => uint256) storage allowed = _allowedAt[msg.sender][agent];
        delete _markets[msg.sender][agent];
        bytes32[] storage list = _markets[msg.sender][agent];
        for (uint256 i; i < markets.length; ++i) {
            bytes32 m = markets[i];
            if (m == bytes32(0) || allowed[m] == gen) continue; // empty or duplicate
            allowed[m] = gen;
            list.push(m);
        }
        emit PolicySet(msg.sender, agent, budgetUsdg, maxPerTradeUsdg, expiresAt, canSell, canBack, list);
    }

    /// @inheritdoc IODAgentRouter
    /// @dev One storage write and an event, no external call: nothing can block it.
    function revoke(address agent) external {
        _policies[msg.sender][agent].revoked = true;
        emit PolicyRevoked(msg.sender, agent);
    }

    // ------------------------------------------------------------------------------------------------- agent

    /// @inheritdoc IODAgentRouter
    function buyFor(address owner, bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        Policy storage p = _active(owner);
        _requireGear(owner, gearId);
        _charge(p, usdgIn);

        // The owner approved the router only; the USDG pays the owner's own buy and the tokens go to the owner.
        // slither-disable-next-line arbitrary-send-erc20
        USDG.safeTransferFrom(owner, address(this), usdgIn);
        USDG.forceApprove(address(MINTER), usdgIn);
        tokensOut = MINTER.buy(gearId, usdgIn, minTokensOut, owner, deadline);
        USDG.forceApprove(address(MINTER), 0);
        // Exact-in uses the whole amount, so nothing is left to refund.
        if (USDG.balanceOf(address(this)) != 0) revert RouterKeptFunds();
        emit AgentTrade(owner, msg.sender, gearId, ACTION_BUY, usdgIn);
    }

    /// @inheritdoc IODAgentRouter
    function sellFor(address owner, bytes32 gearId, uint256 tokens, uint256 minUsdgOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        Policy storage p = _active(owner);
        if (!p.canSell) revert SellNotAllowed();
        GearConfig memory g = _requireGear(owner, gearId);

        // The owner approved the router on this gear token. A sell the minter cannot pay now reverts with UseQueue
        // and the whole call reverts with it: there is no queue on behalf of an owner, the owner queues directly.
        IERC20 token = IERC20(g.token);
        // slither-disable-next-line arbitrary-send-erc20
        token.safeTransferFrom(owner, address(this), tokens);
        token.forceApprove(address(MINTER), tokens);
        usdgOut = MINTER.sell(gearId, tokens, minUsdgOut, owner, deadline);
        token.forceApprove(address(MINTER), 0);
        if (token.balanceOf(address(this)) != 0 || USDG.balanceOf(address(this)) != 0) revert RouterKeptFunds();
        // L-4: a sell is charged its USDG value against the per-trade cap and the budget (reverts the sell if over)
        _charge(p, usdgOut);
        emit AgentTrade(owner, msg.sender, gearId, ACTION_SELL, usdgOut);
    }

    /// @inheritdoc IODAgentRouter
    /// @dev `vaultId == 0` opens a vault owned by `owner`; otherwise the vault must already be the owner's and on
    /// `gearId`. Minting always sells to the Governor, so the proceeds stay with the vault, never with the agent.
    function backFor(
        address owner,
        uint256 vaultId,
        bytes32 gearId,
        uint256 collateralUsdg,
        uint256 mintTokens,
        uint256 minProceedsUsdg,
        uint64 deadline
    ) external nonReentrant returns (uint256 vaultIdOut, uint256 proceeds) {
        if (block.timestamp > deadline) revert IODMinter.Expired();
        Policy storage p = _active(owner);
        if (!p.canBack) revert BackNotAllowed();
        _requireGear(owner, gearId);
        if (vaultId != 0) {
            (address vOwner, bytes32 vGear,,,) = BACKER.vault(vaultId);
            if (vOwner != owner) revert IODBacker.NotVaultOwner(vaultId);
            if (vGear != gearId) revert VaultGearMismatch(vaultId, gearId);
        }
        vaultIdOut = vaultId;
        if (collateralUsdg != 0 || vaultId == 0) {
            // slither-disable-next-line arbitrary-send-erc20
            USDG.safeTransferFrom(owner, address(this), collateralUsdg);
            USDG.forceApprove(address(BACKER), collateralUsdg);
            if (vaultId == 0) vaultIdOut = BACKER.openVaultFor(owner, gearId, collateralUsdg);
            else BACKER.deposit(vaultId, collateralUsdg);
            USDG.forceApprove(address(BACKER), 0);
        }
        if (mintTokens != 0) proceeds = BACKER.mintFor(vaultIdOut, mintTokens, minProceedsUsdg);
        if (USDG.balanceOf(address(this)) != 0) revert RouterKeptFunds();
        // L-4: the collateral moved plus the minted debt (its sale proceeds) count against the cap and the budget
        _charge(p, collateralUsdg + proceeds);
        emit AgentTrade(owner, msg.sender, gearId, ACTION_BACK, collateralUsdg);
    }

    // ------------------------------------------------------------------------------------------------- views

    /// @inheritdoc IODAgentRouter
    function policyOf(address owner, address agent) external view returns (Policy memory) {
        return _policies[owner][agent];
    }

    /// @inheritdoc IODAgentRouter
    function remainingBudget(address owner, address agent) external view returns (uint256) {
        Policy storage p = _policies[owner][agent];
        return p.spentUsdg >= p.budgetUsdg ? 0 : p.budgetUsdg - p.spentUsdg;
    }

    function isAllowedMarket(address owner, address agent, bytes32 market) public view returns (bool) {
        uint256 gen = _generation[owner][agent];
        return gen != 0 && _allowedAt[owner][agent][market] == gen;
    }

    function allowedMarkets(address owner, address agent) external view returns (bytes32[] memory) {
        return _markets[owner][agent];
    }

    // ---------------------------------------------------------------------------------------------- internal

    /// @dev The caller's live policy for `owner` (msg.sender is the agent).
    function _active(address owner) private view returns (Policy storage p) {
        p = _policies[owner][msg.sender];
        if (p.agent == address(0)) revert NoPolicy(owner, msg.sender);
        if (p.revoked) revert PolicyIsRevoked(owner, msg.sender);
        if (block.timestamp >= p.expiresAt) revert PolicyExpired(p.expiresAt);
    }

    /// @dev A single-name gear needs its market allowed; a pair gear needs both of its markets.
    function _requireGear(address owner, bytes32 gearId) private view returns (GearConfig memory g) {
        g = REGISTRY.gear(gearId);
        if (!isAllowedMarket(owner, msg.sender, g.marketA)) revert MarketNotAllowed(g.marketA);
        if (g.marketB != bytes32(0) && !isAllowedMarket(owner, msg.sender, g.marketB)) {
            revert MarketNotAllowed(g.marketB);
        }
    }

    /// @dev Books `usdg` against the per-trade cap and the lifetime budget.
    function _charge(Policy storage p, uint256 usdg) private {
        uint256 maxPerTrade = p.maxPerTradeUsdg;
        if (usdg > maxPerTrade) revert MaxPerTradeExceeded(usdg, maxPerTrade);
        uint256 spent = p.spentUsdg;
        uint256 budget = p.budgetUsdg;
        if (spent + usdg > budget) revert BudgetExceeded(spent, usdg, budget);
        p.spentUsdg = uint128(spent + usdg); // <= budget, a uint128
    }
}
