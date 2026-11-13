// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Stock Token surface (ERC-8056): uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused, paused.
contract MockStockToken is ERC20 {
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt);

    bool public oraclePaused;
    bool public paused;
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier = 1e18;
    uint256 public effectiveAt;

    constructor() ERC20("Mock Stock", "MOCK") {}

    function setOraclePaused(bool v) external {
        oraclePaused = v;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setMultipliers(uint256 current, uint256 pending, uint256 effectiveAt_) external {
        uint256 previous = uiMultiplier;
        uiMultiplier = current;
        newUIMultiplier = pending;
        effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(previous, current, effectiveAt_);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
