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
    error NotVaultOwner(uint256 vaultId);
    error BelowMinimumCollateral();
    error Undercollateralized(uint256 ratioBps, uint256 requiredBps);
    error MintingClosed(bytes32 reason);
    error NotBackable(bytes32 gearId); // ECO (negative toll) and settled gears
    error InBatch(uint256 vaultId);
    error Healthy(uint256 vaultId);
    error BatchNotReady(uint64 readyAt);
    error BatchExpired();
    function openVault(bytes32 gearId, uint256 collateralUsdg) external returns (uint256 vaultId); // min 50 USDG
    function deposit(uint256 vaultId, uint256 usdg) external; // anyone may top up, never blocked
    function withdraw(uint256 vaultId, uint256 usdg, address to) external;
    function mint(uint256 vaultId, uint256 tokens, bool sellToGovernor, uint256 minProceedsUsdg)
        external
        returns (uint256 proceeds);
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
}
