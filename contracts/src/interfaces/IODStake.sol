// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODStake {
    /// @notice Emitted when an account stakes.
    /// @param account The account concerned.
    /// @param amount The amount, in the units of the asset concerned.
    /// @param shares Amount of shares (vault share decimals).
    event Staked(address indexed account, uint256 amount, uint256 shares);
    /// @notice Emitted when an account queues an unstake.
    /// @param account The account concerned.
    /// @param shares Amount of shares (vault share decimals).
    /// @param readyAt Timestamp from which the batch can execute.
    event UnstakeRequested(address indexed account, uint256 shares, uint64 readyAt);
    /// @notice Emitted when a queued unstake is paid out.
    /// @param account The account concerned.
    /// @param shares Amount of shares (vault share decimals).
    /// @param amount The amount, in the units of the asset concerned.
    event Unstaked(address indexed account, uint256 shares, uint256 amount);
    /// @notice Emitted when an account claims its rewards.
    /// @param account The account concerned.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event RewardsClaimed(address indexed account, uint256 usdg);
    /// @notice Emitted when a slash raises USDG.
    /// @param usdgRequested Amount of USDG requested, in 6-decimal units.
    /// @param tokensSold Tokens sold.
    /// @param usdgSent Amount of USDG actually sent, in 6-decimal units.
    event Slashed(uint256 usdgRequested, uint256 tokensSold, uint256 usdgSent);
    /// @notice Emitted when a slash could not be completed.
    /// @param usdgRequested Amount of USDG requested, in 6-decimal units.
    event SlashFailed(uint256 usdgRequested);
    /// @notice Reverts when the caller is neither the Governor nor the Backer.
    error NotSlasher();
    /// @notice Reverts when the unstake request has not yet matured.
    /// @param readyAt Timestamp from which the batch can execute.
    error NotReady(uint64 readyAt);
    /// @notice Stakes tokens and mints shares.
    /// @param amount The amount, in the units of the asset concerned.
    /// @return shares  The shares minted.
    function stake(uint256 amount) external returns (uint256 shares);
    /// @notice Queues an unstake of `shares`, claimable after the unstake delay.
    /// @param shares Amount of shares (vault share decimals).
    function requestUnstake(uint256 shares) external;
    /// @notice Pays out the matured unstake request.
    /// @dev Reverts with NotReady before the request matures.
    /// @return amount  The amount of tokens returned.
    function unstake() external returns (uint256 amount);
    /// @notice Claims the caller's accrued USDG rewards.
    /// @return usdg  Amount of USDG, in 6-decimal units.
    function claimRewards() external returns (uint256 usdg);
    /// @notice Sells staked tokens to raise USDG for a shortfall.
    /// @dev Governor or Backer only (NotSlasher otherwise). Never reverts; a failure emits SlashFailed.
    /// @param usdgNeeded Amount of USDG requested, in 6-decimal units.
    /// @return usdgSent  Amount of USDG actually sent, in 6-decimal units.
    function slash(uint256 usdgNeeded) external returns (uint256 usdgSent); // Governor or Backer only; never reverts
    /// @notice Returns the spread discount an account earns from its stake.
    /// @param account The account concerned.
    /// @return spreadDiscountBps  Spread discount in basis points.
    function feeDiscountOf(address account) external view returns (uint16 spreadDiscountBps);
    /// @notice Returns the voting power of an account at a past timepoint, used for markets and caps votes only.
    /// @param account The account concerned.
    /// @param timepoint Timestamp to read the power at.
    /// @return  The resulting value.
    function votingPower(address account, uint256 timepoint) external view returns (uint256); // markets and caps votes only
    /// @notice Returns the USDG value the stake can cover in a slash.
    /// @return  The resulting value.
    function coverValueUsdg() external view returns (uint256);
}
