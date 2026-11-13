// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODStake {
    event Staked(address indexed account, uint256 amount, uint256 shares);
    event UnstakeRequested(address indexed account, uint256 shares, uint64 readyAt);
    event Unstaked(address indexed account, uint256 shares, uint256 amount);
    event RewardsClaimed(address indexed account, uint256 usdg);
    event Slashed(uint256 usdgRequested, uint256 tokensSold, uint256 usdgSent);
    event SlashFailed(uint256 usdgRequested);
    error NotSlasher();
    error NotReady(uint64 readyAt);
    function stake(uint256 amount) external returns (uint256 shares);
    function requestUnstake(uint256 shares) external;
    function unstake() external returns (uint256 amount);
    function claimRewards() external returns (uint256 usdg);
    function slash(uint256 usdgNeeded) external returns (uint256 usdgSent); // Governor or Backer only; never reverts
    function feeDiscountOf(address account) external view returns (uint16 spreadDiscountBps);
    function votingPower(address account, uint256 timepoint) external view returns (uint256); // markets and caps votes only
    function coverValueUsdg() external view returns (uint256);
}
