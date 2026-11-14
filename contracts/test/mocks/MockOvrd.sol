// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// Stand-in for the launchpad-issued $OVRD (18 decimals, EIP-2612). The protocol never deploys a token: tests only.
contract MockOvrd is ERC20, ERC20Permit {
    constructor() ERC20("Mock OVRD", "mOVRD") ERC20Permit("Mock OVRD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// TWAP and spot source for the $OVRD route (WAD USD per whole token). Modes: 0 normal, 1 revert, 2 short return.
contract MockPriceSource {
    uint256 public twap;
    uint256 public spot;
    uint256 public mode;

    function set(uint256 twap_, uint256 spot_) external {
        (twap, spot) = (twap_, spot_);
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function referencePrice(address, uint24) external view returns (uint256) {
        _misbehave();
        return twap;
    }

    function spotPrice(address, uint24) external view returns (uint256) {
        _misbehave();
        return spot;
    }

    function _misbehave() private view {
        if (mode == 1) revert("price down");
        if (mode == 2) {
            assembly {
                mstore(0, 1)
                return(0, 16)
            }
        }
    }
}

/// Swaps at `priceWad` less `haircutBps`, minting the output token. `fail` makes every swap revert.
contract MockSwapAdapter {
    using SafeERC20 for IERC20;

    address public immutable usdg;
    uint256 public priceWad;
    uint256 public haircutBps;
    bool public fail;

    error InsufficientOutput(uint256 out, uint256 minOut);

    constructor(address usdg_, uint256 priceWad_) {
        usdg = usdg_;
        priceWad = priceWad_;
    }

    function setPrice(uint256 p) external {
        priceWad = p;
    }

    function setHaircut(uint256 bps) external {
        haircutBps = bps;
    }

    function setFail(bool v) external {
        fail = v;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint24, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 out)
    {
        if (fail) revert("swap down");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == usdg) out = amountIn * 1e30 / priceWad;
        else out = amountIn * priceWad / 1e30;
        out = out * (10_000 - haircutBps) / 10_000;
        if (out < minOut) revert InsufficientOutput(out, minOut);
        IMintable(tokenOut).mint(recipient, out);
    }
}

/// Governor stand-in for ODFees: `fundCash` and `fundExitReserve` pull USDG and book it. Modes: 0 normal, 1 revert.
contract MockFeesGovernor {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    uint256 public cash;
    uint256 public exitReserve;
    uint256 public mode;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function fundCash(uint256 amount) external {
        if (mode == 1) revert("governor down");
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        cash += amount;
    }

    function fundExitReserve(uint256 amount) external {
        if (mode == 1) revert("governor down");
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        exitReserve += amount;
    }
}
