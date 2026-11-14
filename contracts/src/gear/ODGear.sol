// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IODGear} from "../interfaces/IODGear.sol";

/// @title ODGear
/// @notice The ERC-20 of one gear (e.g. "Overdrive TSLA Sport", "TSLA-SPORT"), deployed as an EIP-1167 clone by the
/// ODGearFactory. 18 decimals. Balances never change except by the minter's mint and burn and by plain transfers: the
/// toll moves the normalisation factor held by the minter, never a balance. EIP-2612 permit uses the token's own
/// domain (its name, version "1", the chain id and the clone's address).
/// @dev The clone is not upgradeable. `initialize` runs once, in the factory's deploy call.
contract ODGear is ERC20PermitUpgradeable, IODGear {
    /// @notice Reverts when the minter address is invalid.
    error InvalidMinter();

    address public minter;
    bytes32 public gearId;

    constructor() {
        // The implementation itself is never a live token.
        _disableInitializers();
    }

    /// @notice One-time setup of a fresh clone. The factory calls this in the same transaction as the clone deployment.
    function initialize(address minter_, bytes32 gearId_, string calldata name_, string calldata symbol_)
        external
        initializer
    {
        if (minter_ == address(0)) revert InvalidMinter();
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        minter = minter_;
        gearId = gearId_;
    }

    /// @notice Mints to a buyer. Only the minter.
    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /// @notice Burns from a seller during that seller's own sell. Only the minter.
    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }

    /// @inheritdoc IERC20Permit
    function nonces(address owner) public view override(ERC20PermitUpgradeable, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }
}
