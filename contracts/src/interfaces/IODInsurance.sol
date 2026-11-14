// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODInsurance {
    /// @notice Emitted when the fund covers a shortfall.
    /// @param to The recipient address.
    /// @param requested Amount requested.
    /// @param sent Amount actually sent.
    event Covered(address indexed to, uint256 requested, uint256 sent);
    /// @notice Emitted when the fund receives USDG.
    /// @param from The source address.
    /// @param usdg Amount of USDG, in 6-decimal units.
    event Funded(address indexed from, uint256 usdg);
    /// @notice Reverts when the caller is neither the Governor nor the Backer.
    error NotCoverer();
    /// @notice Pays out up to `usdg` to cover a shortfall.
    /// @dev Governor or Backer only (NotCoverer otherwise). Sends min(usdg, balance) and never reverts on a low balance.
    /// @param usdg Amount of USDG, in 6-decimal units.
    /// @return sent  Amount actually sent.
    function cover(uint256 usdg) external returns (uint256 sent); // Governor or Backer only; min(usdg, balance), never reverts on low balance
    /// @notice Adds USDG to the fund.
    /// @dev Anyone may call.
    /// @param usdg Amount of USDG, in 6-decimal units.
    function fund(uint256 usdg) external; // anyone
    /// @notice Returns the USDG balance of the fund.
    /// @return  The resulting value.
    function balance() external view returns (uint256);
}
