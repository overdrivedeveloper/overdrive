// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODBacker {
    event VaultOpened(uint256 indexed vaultId, address indexed owner, bytes32 indexed gearId);
    event CollateralMoved(uint256 indexed vaultId, int256 deltaUsdg, uint256 collateralAfter);
    event Minted(uint256 indexed vaultId, uint256 tokens, bool soldToGovernor, uint256 proceedsUsdg);
    event Repaid(uint256 indexed vaultId, uint256 tokens, uint256 usdgSpent);
    event TollFeeCharged(uint256 indexed vaultId, uint256 usdg);
    event BatchSealed(
        uint256 indexed batchId, bytes32 indexed gearId, uint256 sealedValueWad, uint64 sealedAt, uint256[] vaultIds
    );
    event Liquidated(
        uint256 indexed batchId,
        uint256 indexed vaultId,
        uint256 debtTokens,
        uint256 collateralSeized,
        uint256 bonusUsdg,
        uint256 badDebtUsdg
    );
    event BatchVoided(uint256 indexed batchId, bytes32 reason);
    event OperatorSet(address indexed owner, address indexed operator, bool allowed);
    error NotVaultOwner(uint256 vaultId);
    error BelowMinimumCollateral();
    error Undercollateralized(uint256 ratioBps, uint256 requiredBps);
    error MintingClosed(bytes32 reason);
    error NotBackable(bytes32 gearId); // ECO (negative toll) and settled gears
    error InBatch(uint256 vaultId);
    error Healthy(uint256 vaultId);
    error BatchNotReady(uint64 readyAt);
    error BatchExpired();
    error NotOperator(address owner, address operator);
    function openVault(bytes32 gearId, uint256 collateralUsdg) external returns (uint256 vaultId); // min 50 USDG
    // Opens a vault OWNED BY `owner`, collateral pulled from msg.sender (the agent router uses it; a gift otherwise).
    function openVaultFor(address owner, bytes32 gearId, uint256 collateralUsdg) external returns (uint256 vaultId);
    function deposit(uint256 vaultId, uint256 usdg) external; // anyone may top up, never blocked
    function withdraw(uint256 vaultId, uint256 usdg, address to) external;
    function mint(uint256 vaultId, uint256 tokens, bool sellToGovernor, uint256 minProceedsUsdg)
        external
        returns (uint256 proceeds);
    // Operator mint (todo 10): msg.sender must be an operator of the vault owner; always sells to the Governor, so
    // the proceeds stay as vault collateral and nothing reaches the operator.
    function mintFor(uint256 vaultId, uint256 tokens, uint256 minProceedsUsdg) external returns (uint256 proceeds);
    function setOperator(address operator, bool allowed) external; // msg.sender is the owner
    function isOperator(address owner, address operator) external view returns (bool);
    function repay(uint256 vaultId, uint256 tokens) external; // burns tokens from msg.sender, never blocked
    function repayWithUsdg(uint256 vaultId, uint256 tokens, uint256 maxCostUsdg) external returns (uint256 cost);
    function sealBatch(bytes32 gearId, uint256[] calldata vaultIds) external returns (uint256 batchId); // anyone
    function executeBatch(uint256 batchId) external returns (uint256 liquidated); // anyone
    function health(uint256 vaultId)
        external
        view
        returns (
            uint256 collateralUsdg,
            uint256 debtValueWad,
            uint256 ratioBps,
            uint256 requiredBps,
            uint256 maintenanceBps
        );
    function vault(uint256 vaultId)
        external
        view
        returns (address owner, bytes32 gearId, uint256 collateralUsdg, uint256 debtTokens, uint256 batchId);
    function upliftActive(bytes32 market) external view returns (bool active, uint16 upliftBps);
    // 07a additions
    event UpliftSet(uint16 upliftBps, uint32 lead);
    event MintPausedSet(bool paused);
    error Slippage(uint256 got, uint256 limit);
    function setUplift(uint16 upliftBps, uint32 lead) external; // admin any (bounded); guardian may only raise
    function setMintPaused(bool paused) external; // guardian pauses, admin (timelock) unpauses
    function tollFeeOwed(uint256 vaultId) external view returns (uint256 usdg); // charged at the next vault action
    function mintPaused() external view returns (bool);
    function uplift() external view returns (uint16 upliftBps, uint32 lead);
    function vaultCount() external view returns (uint256);
    function totalCollateral() external view returns (uint256 usdg); // sum of vault collateral (internal accounting)
    function pendingFees() external view returns (uint256 usdg); // charged toll fees not yet sent to ODFees
    function sendFees(bytes32 gearId) external; // anyone: sends pending toll fees to ODFees ("BACKER_TOLL")
    // liquidation timing and bonus (07b executes batches; the off-chain liquidator, todo 17, reads these)
    function SEAL_DELAY() external view returns (uint32); // execute no earlier than sealedAt + SEAL_DELAY
    function BATCH_TTL() external view returns (uint32); // after sealedAt + BATCH_TTL the batch is void, vaults free
    function BONUS_BPS() external view returns (uint16); // executor bonus, of the debt value
    function batchWindow(uint256 batchId) external view returns (uint64 readyAt, uint64 expiresAt); // (0, 0) unknown
}
