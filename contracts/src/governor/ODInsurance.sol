// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IODInsurance} from "../interfaces/IODInsurance.sol";

/// @title ODInsurance
/// @notice A USDG pot that only the Governor and the backer contract may draw. `cover` sends min(request, balance) to
/// the caller and never reverts on a low balance; anyone may `fund` it. It is not part of the Governor's NAV.
/// @dev The Governor and backer addresses may be zero at construction (the Governor takes this contract's address);
/// the admin sets each once with `setCoverers`.
contract ODInsurance is AccessControl, ReentrancyGuardTransient, IODInsurance {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    address public governor;
    address public backer;

    event CoverersSet(address governor, address backer);

    error InvalidParams();

    constructor(IERC20 usdg_, address admin, address governor_, address backer_) {
        if (address(usdg_) == address(0) || admin == address(0)) revert InvalidParams();
        usdg = usdg_;
        governor = governor_;
        backer = backer_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Admin: sets the Governor and the backer contract, each only while unset.
    function setCoverers(address governor_, address backer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (governor_ != address(0)) {
            if (governor != address(0)) revert InvalidParams();
            governor = governor_;
        }
        if (backer_ != address(0)) {
            if (backer != address(0)) revert InvalidParams();
            backer = backer_;
        }
        emit CoverersSet(governor, backer);
    }

    /// @inheritdoc IODInsurance
    function cover(uint256 amount) external nonReentrant returns (uint256 sent) {
        if (msg.sender == address(0) || (msg.sender != governor && msg.sender != backer)) revert NotCoverer();
        uint256 bal = usdg.balanceOf(address(this));
        sent = amount < bal ? amount : bal;
        if (sent != 0) usdg.safeTransfer(msg.sender, sent);
        emit Covered(msg.sender, amount, sent);
    }

    /// @inheritdoc IODInsurance
    function fund(uint256 amount) external nonReentrant {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @inheritdoc IODInsurance
    function balance() external view returns (uint256) {
        return usdg.balanceOf(address(this));
    }
}
