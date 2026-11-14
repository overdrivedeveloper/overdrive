// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODAgentRouter {
    struct Policy {
        address agent;
        uint128 budgetUsdg;
        uint128 spentUsdg;
        uint128 maxPerTradeUsdg;
        uint64 expiresAt;
        bool canSell;
        bool canBack;
        bool revoked;
    }
    /// @notice Emitted when an owner sets a policy for an agent.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    /// @param budgetUsdg Total USDG the agent may spend under the policy, 6 decimals.
    /// @param maxPerTradeUsdg Largest single trade the agent may make, in USDG.
    /// @param expiresAt Timestamp at which the policy expires.
    /// @param canSell Whether the agent may sell.
    /// @param canBack Whether the agent may open or change backer vaults.
    /// @param markets List of market ids.
    event PolicySet(
        address indexed owner,
        address indexed agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canBack,
        bytes32[] markets
    );
    /// @notice Emitted when an owner revokes an agent policy.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    event PolicyRevoked(address indexed owner, address indexed agent);
    /// @notice Emitted when an agent trades for an owner.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param action Action tag (bytes32).
    /// @param usdg Amount of USDG, in 6-decimal units.
    event AgentTrade(
        address indexed owner, address indexed agent, bytes32 indexed gearId, bytes32 action, uint256 usdg
    );
    /// @notice Reverts when the agent has no policy from the owner.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    error NoPolicy(address owner, address agent);
    /// @notice Reverts when the policy has been revoked.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    error PolicyIsRevoked(address owner, address agent);
    /// @notice Reverts when the policy has expired.
    /// @param expiresAt Timestamp at which the policy expires.
    error PolicyExpired(uint64 expiresAt);
    /// @notice Reverts when the market is outside the policy allow-list.
    /// @param market Market id (bytes32 symbol key).
    error MarketNotAllowed(bytes32 market);
    /// @notice Reverts when the policy does not allow selling.
    error SellNotAllowed();
    /// @notice Reverts when the policy does not allow backer actions.
    error BackNotAllowed();
    /// @notice Reverts when a trade exceeds the per-trade limit of the policy.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @param maxPerTradeUsdg Largest single trade the agent may make, in USDG.
    error MaxPerTradeExceeded(uint256 usdg, uint256 maxPerTradeUsdg);
    /// @notice Reverts when a trade would exceed the budget of the policy.
    /// @param spentUsdg USDG already spent under the policy.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @param budgetUsdg Total USDG the agent may spend under the policy, 6 decimals.
    error BudgetExceeded(uint256 spentUsdg, uint256 usdg, uint256 budgetUsdg);
    /// @notice Sets or replaces the caller's policy for an agent.
    /// @dev The caller is the owner. The agent can then trade for the owner within the budget, per-trade limit, expiry and
    /// markets given.
    /// @param agent The agent address the policy applies to.
    /// @param budgetUsdg Total USDG the agent may spend under the policy, 6 decimals.
    /// @param maxPerTradeUsdg Largest single trade the agent may make, in USDG.
    /// @param expiresAt Timestamp at which the policy expires.
    /// @param canSell Whether the agent may sell.
    /// @param canBack Whether the agent may open or change backer vaults.
    /// @param markets List of market ids.
    function setPolicy(
        address agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canBack,
        bytes32[] calldata markets
    ) external;
    /// @notice Revokes the caller's policy for an agent.
    /// @dev The caller is the owner.
    /// @param agent The agent address the policy applies to.
    function revoke(address agent) external;
    /// @notice Buys gear tokens for an owner within the agent's policy.
    /// @dev The agent is the caller. Reverts with NoPolicy, PolicyIsRevoked, PolicyExpired, MarketNotAllowed,
    /// MaxPerTradeExceeded or BudgetExceeded.
    /// @param owner The owner account.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param usdgIn Amount of USDG paid in, in 6-decimal units.
    /// @param minTokensOut Minimum gear tokens to receive, else the call reverts.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return tokensOut  Amount of gear tokens paid out (18 decimals).
    function buyFor(address owner, bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, uint64 deadline)
        external
        returns (uint256 tokensOut);
    /// @notice Sells an owner's gear tokens within the agent's policy.
    /// @dev The agent is the caller. Reverts with SellNotAllowed as well as the policy errors of buyFor.
    /// @param owner The owner account.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param minUsdgOut Minimum USDG to receive, else the call reverts.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return usdgOut  Amount of USDG paid out, in 6-decimal units.
    function sellFor(address owner, bytes32 gearId, uint256 tokens, uint256 minUsdgOut, uint64 deadline)
        external
        returns (uint256 usdgOut);
    /// @notice Opens or tops up a backer vault for an owner within the agent's policy.
    /// @dev The agent is the caller. Reverts with BackNotAllowed as well as the policy errors of buyFor.
    /// @param owner The owner account.
    /// @param vaultId Id of an existing vault, or zero to open a new one.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param collateralUsdg Collateral amount in USDG, in 6-decimal units.
    /// @param mintTokens Gear tokens to mint, 18 decimals.
    /// @param minProceedsUsdg Minimum USDG proceeds from the mint, else it reverts.
    /// @param deadline Latest timestamp at which the call may execute.
    /// @return vaultIdOut  Id of the vault used or opened.
    /// @return proceeds  USDG proceeds, in 6-decimal units.
    function backFor(
        address owner,
        uint256 vaultId,
        bytes32 gearId,
        uint256 collateralUsdg,
        uint256 mintTokens,
        uint256 minProceedsUsdg,
        uint64 deadline
    ) external returns (uint256 vaultIdOut, uint256 proceeds);
    /// @notice Returns the policy of an agent for an owner.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    /// @return  The policy record.
    function policyOf(address owner, address agent) external view returns (Policy memory);
    /// @notice Returns the unspent budget of an agent for an owner.
    /// @param owner The owner account.
    /// @param agent The agent address the policy applies to.
    /// @return  Remaining USDG, 6 decimals.
    function remainingBudget(address owner, address agent) external view returns (uint256);
}
