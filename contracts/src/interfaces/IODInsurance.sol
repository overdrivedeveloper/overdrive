// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IODInsurance {
    event Covered(address indexed to, uint256 requested, uint256 sent);
    event Funded(address indexed from, uint256 usdg);
    error NotCoverer();
    function cover(uint256 usdg) external returns (uint256 sent); // Governor or Backer only; min(usdg, balance), never reverts on low balance
    function fund(uint256 usdg) external; // anyone
    function balance() external view returns (uint256);
}
