// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// 6-decimals dollar token with a global pause and a per-account blocklist (simulates a payout that fails).
contract MockUSDG is ERC20, ERC20Permit {
    bool public paused;
    mapping(address => bool) public blocked;

    error TokenPaused();
    error AccountBlocked(address account);

    constructor() ERC20("Global Dollar", "USDG") ERC20Permit("Global Dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setBlocked(address account, bool v) external {
        blocked[account] = v;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (paused) revert TokenPaused();
        if (blocked[from]) revert AccountBlocked(from);
        if (blocked[to]) revert AccountBlocked(to);
        super._update(from, to, value);
    }
}
