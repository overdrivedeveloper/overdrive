// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODBacker {
    /// A sealed liquidation batch (07b). `sealedValueWad` is the per-token debt value at the high side of p and refP
    /// when sealed; every vault in it is liquidated at that value, or released if rescued.
    struct Batch {
        bytes32 gearId;
        uint256 sealedValueWad;
        uint64 sealedAt;
        uint64 feedUpdatedAt;
        uint256[] vaultIds;
        bool done;
    }
    /// @notice Emitted when a vault is opened.
    /// @param vaultId Id of the vault.
    /// @param owner The owner account.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    event VaultOpened(uint256 indexed vaultId, address indexed owner, bytes32 indexed gearId);
    /// @notice Emitted when collateral is deposited into or withdrawn from a vault.
    /// @param vaultId Id of the vault.
    /// @param deltaUsdg Signed change in vault collateral, in USDG.
    /// @param collateralAfter The vault collateral after the move, in USDG.
    event CollateralMoved(uint256 indexed vaultId, int256 deltaUsdg, uint256 collateralAfter);
    /// @notice Emitted when a vault mints gear tokens against its collateral.
    /// @param vaultId Id of the vault.
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param soldToGovernor True if the minted tokens were sold to the Governor.
    /// @param proceedsUsdg USDG proceeds, in 6-decimal units.
    event Minted(uint256 indexed vaultId, uint256 tokens, bool soldToGovernor, uint256 proceedsUsdg);
    /// @notice Emitted when a vault repays gear tokens.
    /// @param vaultId Id of the vault.
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param usdgSpent USDG spent, in 6-decimal units.
    event Repaid(uint256 indexed vaultId, uint256 tokens, uint256 usdgSpent);
    /// @notice Emitted when a toll fee is charged to a vault.
    /// @param vaultId Id of the vault.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event TollFeeCharged(uint256 indexed vaultId, uint256 usdg);
    /// @notice Emitted when a liquidation batch is sealed.
    /// @param batchId Id of the liquidation batch.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param sealedValueWad Per-token debt value fixed at seal, WAD.
    /// @param sealedAt Timestamp the batch was sealed.
    /// @param vaultIds Ids of the vaults.
    event BatchSealed(
        uint256 indexed batchId, bytes32 indexed gearId, uint256 sealedValueWad, uint64 sealedAt, uint256[] vaultIds
    );
    /// @notice Emitted when a vault is liquidated inside a batch.
    /// @param batchId Id of the liquidation batch.
    /// @param vaultId Id of the vault.
    /// @param debtTokens Debt in gear tokens (18 decimals).
    /// @param collateralSeized Collateral seized, in USDG.
    /// @param bonusUsdg Executor bonus, in USDG.
    /// @param badDebtUsdg Bad debt left after collateral, in USDG.
    event Liquidated(
        uint256 indexed batchId,
        uint256 indexed vaultId,
        uint256 debtTokens,
        uint256 collateralSeized,
        uint256 bonusUsdg,
        uint256 badDebtUsdg
    );
    /// @notice Emitted when a batch is voided.
    /// @param batchId Id of the liquidation batch.
    /// @param reason Reason code (bytes32 tag).
    event BatchVoided(uint256 indexed batchId, bytes32 reason);
    /// @notice Emitted when an owner sets or clears an operator.
    /// @param owner The owner account.
    /// @param operator The operator account.
    /// @param allowed True to allow, false to disallow.
    event OperatorSet(address indexed owner, address indexed operator, bool allowed);
    /// @notice Reverts when the caller does not own the vault.
    /// @param vaultId Id of the vault.
    error NotVaultOwner(uint256 vaultId);
    /// @notice Reverts when the collateral is below the minimum for a vault (50 USDG).
    error BelowMinimumCollateral();
    /// @notice Reverts when the action would leave the vault below its required collateral ratio.
    /// @param ratioBps Collateral ratio in basis points.
    /// @param requiredBps Required collateral ratio in basis points.
    error Undercollateralized(uint256 ratioBps, uint256 requiredBps);
    /// @notice Reverts when minting is closed for the market, with the reason code.
    /// @param reason Reason code (bytes32 tag).
    error MintingClosed(bytes32 reason);
    /// @notice Reverts when the gear cannot be backed (ECO gears with a negative toll, and settled gears).
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    error NotBackable(bytes32 gearId); // ECO (negative toll) and settled gears
    /// @notice Reverts when the vault is inside a sealed batch and cannot be changed.
    /// @param vaultId Id of the vault.
    error InBatch(uint256 vaultId);
    /// @notice Reverts when the vault is healthy and cannot be liquidated.
    /// @param vaultId Id of the vault.
    error Healthy(uint256 vaultId);
    /// @notice Reverts when the batch is executed before its seal delay has passed.
    /// @param readyAt Timestamp from which the batch can execute.
    error BatchNotReady(uint64 readyAt);
    /// @notice Reverts when the batch is executed after its time to live.
    error BatchExpired();
    /// @notice Reverts when the caller is not an operator of the vault owner.
    /// @param owner The owner account.
    /// @param operator The operator account.
    error NotOperator(address owner, address operator);
    /// @notice Opens a vault for the caller and pulls the initial collateral.
    /// @dev Reverts with BelowMinimumCollateral under 50 USDG and with NotBackable for ECO or settled gears.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param collateralUsdg Collateral amount in USDG, in 6-decimal units.
    /// @return vaultId  Id of the vault.
    function openVault(bytes32 gearId, uint256 collateralUsdg) external returns (uint256 vaultId); // min 50 USDG
    // Opens a vault OWNED BY `owner`, collateral pulled from msg.sender (the agent router uses it; a gift otherwise).
    /// @notice Opens a vault owned by `owner`, with the collateral pulled from the caller.
    /// @dev Used by the agent router; to any other caller it is a gift to the owner. Same reverts as openVault.
    /// @param owner The owner account.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param collateralUsdg Collateral amount in USDG, in 6-decimal units.
    /// @return vaultId  Id of the vault.
    function openVaultFor(address owner, bytes32 gearId, uint256 collateralUsdg) external returns (uint256 vaultId);
    /// @notice Adds collateral to a vault.
    /// @dev Anyone may top up a vault and it is never blocked.
    /// @param vaultId Id of the vault.
    /// @param usdg Amount of USDG, in 6-decimal units.
    function deposit(uint256 vaultId, uint256 usdg) external; // anyone may top up, never blocked
    /// @notice Withdraws collateral from a vault to `to`.
    /// @dev Only the vault owner may call. Reverts with Undercollateralized if the remainder would not cover the debt, and
    /// with InBatch inside a batch.
    /// @param vaultId Id of the vault.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @param to The recipient address.
    function withdraw(uint256 vaultId, uint256 usdg, address to) external;
    /// @notice Mints gear tokens against the vault collateral.
    /// @dev Only the vault owner may call. Reverts with Undercollateralized, MintingClosed or Slippage.
    /// @param vaultId Id of the vault.
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param sellToGovernor True to sell the minted tokens to the Governor.
    /// @param minProceedsUsdg Minimum USDG proceeds, else the call reverts.
    /// @return proceeds  USDG proceeds, in 6-decimal units.
    function mint(uint256 vaultId, uint256 tokens, bool sellToGovernor, uint256 minProceedsUsdg)
        external
        returns (uint256 proceeds);
    // Operator mint (todo 10): msg.sender must be an operator of the vault owner; always sells to the Governor, so
    // the proceeds stay as vault collateral and nothing reaches the operator.
    /// @notice Operator mint: mints gear tokens for the vault owner and always sells them to the Governor.
    /// @dev The caller must be an operator of the owner (NotOperator otherwise). The proceeds stay as vault collateral and
    /// nothing reaches the operator.
    /// @param vaultId Id of the vault.
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param minProceedsUsdg Minimum USDG proceeds, else the call reverts.
    /// @return proceeds  USDG proceeds, in 6-decimal units.
    function mintFor(uint256 vaultId, uint256 tokens, uint256 minProceedsUsdg) external returns (uint256 proceeds);
    /// @notice Sets or clears an operator for the caller's vaults.
    /// @dev The caller is the owner.
    /// @param operator The operator account.
    /// @param allowed True to allow, false to disallow.
    function setOperator(address operator, bool allowed) external; // msg.sender is the owner
    /// @notice Returns whether `operator` may act for `owner`.
    /// @param owner The owner account.
    /// @param operator The operator account.
    /// @return  True when the operator is set.
    function isOperator(address owner, address operator) external view returns (bool);
    /// @notice Burns gear tokens from the caller to reduce a vault debt.
    /// @dev Never blocked.
    /// @param vaultId Id of the vault.
    /// @param tokens Amount of gear tokens (18 decimals).
    function repay(uint256 vaultId, uint256 tokens) external; // burns tokens from msg.sender, never blocked
    /// @notice Repays vault debt by paying USDG at the current value instead of tokens.
    /// @dev Reverts with Slippage if the cost exceeds `maxCostUsdg`.
    /// @param vaultId Id of the vault.
    /// @param tokens Amount of gear tokens (18 decimals).
    /// @param maxCostUsdg Maximum USDG cost the caller accepts, else the call reverts.
    /// @return cost  USDG cost, in 6-decimal units.
    function repayWithUsdg(uint256 vaultId, uint256 tokens, uint256 maxCostUsdg) external returns (uint256 cost);
    /// @notice Seals a liquidation batch of unhealthy vaults at the current debt value.
    /// @dev Anyone may call. Reverts with SealRefused when the market is not live, the reference price is unavailable, the
    /// round is stale, the gear is settled, or no listed vault is unhealthy.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    /// @param vaultIds Ids of the vaults.
    /// @return batchId  Id of the liquidation batch.
    function sealBatch(bytes32 gearId, uint256[] calldata vaultIds) external returns (uint256 batchId); // anyone
    /// @notice Executes a sealed batch and liquidates its vaults.
    /// @dev Anyone may call, within the batch window and the allowed drift from the sealed value. Reverts with
    /// BatchNotReady, BatchExpired, BatchDone, UnknownBatch or ExecuteOutOfGas.
    /// @param batchId Id of the liquidation batch.
    /// @return liquidated  Number of vaults liquidated.
    function executeBatch(uint256 batchId) external returns (uint256 liquidated); // anyone
    /// @notice Returns the collateral position of a vault.
    /// @param vaultId Id of the vault.
    /// @return collateralUsdg  Collateral amount in USDG, in 6-decimal units.
    /// @return debtValueWad  Debt value in USD, WAD (18 decimals).
    /// @return ratioBps  Collateral ratio in basis points.
    /// @return requiredBps  Required collateral ratio in basis points.
    /// @return maintenanceBps  Maintenance ratio in basis points.
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
    /// @notice Returns the stored state of a vault.
    /// @param vaultId Id of the vault.
    /// @return owner  The owner account.
    /// @return gearId  Id of the gear (the registry key derived from its market pair and kind).
    /// @return collateralUsdg  Collateral amount in USDG, in 6-decimal units.
    /// @return debtTokens  Debt in gear tokens (18 decimals).
    /// @return batchId  Id of the liquidation batch.
    function vault(uint256 vaultId)
        external
        view
        returns (address owner, bytes32 gearId, uint256 collateralUsdg, uint256 debtTokens, uint256 batchId);
    /// @notice Returns whether a collateral uplift applies to `market` now.
    /// @param market Market id (bytes32 symbol key).
    /// @return active  True when active.
    /// @return upliftBps  Uplift in basis points.
    function upliftActive(bytes32 market) external view returns (bool active, uint16 upliftBps);
    // 07a additions
    /// @notice Emitted when the uplift is set.
    /// @param upliftBps Uplift in basis points.
    /// @param lead Lead time in seconds.
    event UpliftSet(uint16 upliftBps, uint32 lead);
    /// @notice Emitted when minting is paused or unpaused.
    /// @param paused True to pause, false to unpause.
    event MintPausedSet(bool paused);
    /// @notice Reverts when the result is worse than the caller's limit.
    /// @param got The amount obtained.
    /// @param limit The limit the caller set.
    error Slippage(uint256 got, uint256 limit);
    /// @notice Sets the collateral uplift and its lead time.
    /// @dev Admin may set any value within bounds; the guardian may only raise it.
    /// @param upliftBps Uplift in basis points.
    /// @param lead Lead time in seconds.
    function setUplift(uint16 upliftBps, uint32 lead) external; // admin any (bounded); guardian may only raise
    /// @notice Pauses or unpauses minting.
    /// @dev The guardian pauses; the admin (timelock) unpauses.
    /// @param paused True to pause, false to unpause.
    function setMintPaused(bool paused) external; // guardian pauses, admin (timelock) unpauses
    /// @notice Returns the toll fee owed by a vault, charged at its next action.
    /// @param vaultId Id of the vault.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function tollFeeOwed(uint256 vaultId) external view returns (uint256 usdg); // charged at the next vault action
    /// @notice Returns whether minting is paused.
    /// @return  True when paused.
    function mintPaused() external view returns (bool);
    /// @notice Returns the current uplift and its lead time.
    /// @return upliftBps  Uplift in basis points.
    /// @return lead  Lead time in seconds.
    function uplift() external view returns (uint16 upliftBps, uint32 lead);
    /// @notice Returns the number of vaults opened.
    /// @return  The vault count.
    function vaultCount() external view returns (uint256);
    /// @notice Returns the sum of vault collateral by internal accounting.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function totalCollateral() external view returns (uint256 usdg); // sum of vault collateral (internal accounting)
    /// @notice Returns the charged toll fees not yet sent to ODFees.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function pendingFees() external view returns (uint256 usdg); // charged toll fees not yet sent to ODFees
    /// @notice Sends the pending toll fees to ODFees under the BACKER_TOLL kind.
    /// @dev Anyone may call.
    /// @param gearId Id of the gear (the registry key derived from its market pair and kind).
    function sendFees(bytes32 gearId) external; // anyone: sends pending toll fees to ODFees ("BACKER_TOLL")
    // liquidation timing and bonus (07b executes batches; the off-chain liquidator, todo 17, reads these)
    /// @notice Returns the delay between sealing and the earliest execution.
    /// @return  Seconds after sealedAt before execution.
    function SEAL_DELAY() external view returns (uint32); // execute no earlier than sealedAt + SEAL_DELAY
    /// @notice Returns how long a sealed batch stays executable.
    /// @return  Seconds after sealedAt after which the batch is void and its vaults are free.
    function BATCH_TTL() external view returns (uint32); // after sealedAt + BATCH_TTL the batch is void, vaults free
    /// @notice Returns the executor bonus as a share of the debt value.
    /// @return  Bonus in basis points.
    function BONUS_BPS() external view returns (uint16); // executor bonus, of the debt value
    /// @notice Returns the execution window of a batch, or (0, 0) for an unknown batch.
    /// @param batchId Id of the liquidation batch.
    /// @return readyAt  Timestamp from which the batch can execute.
    /// @return expiresAt  Timestamp at which the policy expires.
    function batchWindow(uint256 batchId) external view returns (uint64 readyAt, uint64 expiresAt); // (0, 0) unknown
    // 07b additions (sealed-batch liquidation)
    /// @notice Reverts when sealing is refused, with a reason: NOT_LIVE, REF_UNAVAILABLE, STALE_ROUND, SETTLED or
    /// NONE_UNHEALTHY.
    /// @param reason Reason code (bytes32 tag).
    error SealRefused(bytes32 reason); // NOT_LIVE, REF_UNAVAILABLE, STALE_ROUND, SETTLED, NONE_UNHEALTHY
    /// @notice Reverts when the batch id does not exist.
    /// @param batchId Id of the liquidation batch.
    error UnknownBatch(uint256 batchId);
    /// @notice Reverts when the batch has already been executed.
    /// @param batchId Id of the liquidation batch.
    error BatchDone(uint256 batchId);
    /// @notice Reverts when an execute call lacks the gas to process every vault; the batch stays open.
    error ExecuteOutOfGas(); // M-6: an execute without enough gas for every vault reverts; the batch stays open
    /// @notice Returns the largest allowed move from the sealed value at execution.
    /// @return  Drift in basis points (1%).
    function MAX_SEAL_DRIFT_BPS() external view returns (uint16); // execute only within 1% of the sealed value
    /// @notice Returns the executor floor per vault, applied as min(bonus, this).
    /// @return  Reward cap in USDG, 6 decimals.
    function MIN_REWARD_USDG() external view returns (uint64); // executor floor per vault, min(bonus, this)
    /// @notice Returns the maximum number of vaults in a batch.
    /// @return  The batch size limit.
    function MAX_BATCH() external view returns (uint8);
    /// @notice Returns the oldest feed round allowed at seal.
    /// @return  Age in seconds.
    function MAX_ROUND_AGE() external view returns (uint32); // the feed round at seal is at most this old
    /// @notice Returns the number of batches sealed.
    /// @return  The batch count.
    function batchCount() external view returns (uint256);
    /// @notice Returns a sealed batch.
    /// @param batchId Id of the liquidation batch.
    /// @return  The batch record.
    function batch(uint256 batchId) external view returns (Batch memory);
    /// @notice Emitted when the stake contract is set.
    /// @param stake Address of the stake contract (zero for none).
    event StakeSet(address stake);
    /// @notice Sets the stake contract that takes bad-debt slashes after the insurance fund.
    /// @dev Admin (timelock) only. Zero means none.
    /// @param stake Address of the stake contract (zero for none).
    function setStake(address stake) external; // admin (timelock): the bad-debt slash target after insurance, 0 = none
    /// @notice Returns the stake contract used for bad-debt slashes.
    /// @return  The stake address, or zero.
    function stake() external view returns (address);
}
