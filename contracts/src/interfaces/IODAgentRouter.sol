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
    event PolicyRevoked(address indexed owner, address indexed agent);
    event AgentTrade(
        address indexed owner, address indexed agent, bytes32 indexed gearId, bytes32 action, uint256 usdg
    );
    error NoPolicy(address owner, address agent);
    error PolicyIsRevoked(address owner, address agent);
    error PolicyExpired(uint64 expiresAt);
    error MarketNotAllowed(bytes32 market);
    error SellNotAllowed();
    error BackNotAllowed();
    error MaxPerTradeExceeded(uint256 usdg, uint256 maxPerTradeUsdg);
    error BudgetExceeded(uint256 spentUsdg, uint256 usdg, uint256 budgetUsdg);
    function setPolicy(
        address agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canBack,
        bytes32[] calldata markets
    ) external;
    function revoke(address agent) external;
    function buyFor(address owner, bytes32 gearId, uint256 usdgIn, uint256 minTokensOut, uint64 deadline)
        external
        returns (uint256 tokensOut);
    function sellFor(address owner, bytes32 gearId, uint256 tokens, uint256 minUsdgOut, uint64 deadline)
        external
        returns (uint256 usdgOut);
    function backFor(
        address owner,
        uint256 vaultId,
        bytes32 gearId,
        uint256 collateralUsdg,
        uint256 mintTokens,
        uint256 minProceedsUsdg,
        uint64 deadline
    ) external returns (uint256 vaultIdOut, uint256 proceeds);
    function policyOf(address owner, address agent) external view returns (Policy memory);
    function remainingBudget(address owner, address agent) external view returns (uint256);
}
