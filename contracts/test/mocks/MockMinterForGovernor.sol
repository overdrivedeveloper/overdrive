// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NormState} from "overdrive/interfaces/ODTypes.sol";
import {IODGear} from "overdrive/interfaces/IODGear.sol";
import {IODGovernor} from "overdrive/interfaces/IODGovernor.sol";
import {IODGearRegistry} from "overdrive/interfaces/IODGearRegistry.sol";

/// Drives the Governor's minter hooks the way ODMinter will (05b): buys move USDG from the payer to the Governor and
/// mint first, then call onBuy; sells burn first, then onSell (books and pays). NF and settled values are settable.
contract MockMinterForGovernor {
    IERC20 public immutable usdg;
    IODGearRegistry public immutable registry;
    IODGovernor public governor;
    mapping(bytes32 => uint256) public nfOf;
    mapping(bytes32 => uint256) public settledValue;

    constructor(IERC20 usdg_, IODGearRegistry registry_) {
        usdg = usdg_;
        registry = registry_;
    }

    function setGovernor(IODGovernor g) external {
        governor = g;
    }

    function setNf(bytes32 id, uint256 nf) external {
        nfOf[id] = nf;
    }

    function setSettledValue(bytes32 id, uint256 v) external {
        settledValue[id] = v;
    }

    function buy(bytes32 id, address payer, address to, uint256 tokens, uint256 usdgIn, uint256 spreadUsdg) external {
        usdg.transferFrom(payer, address(governor), usdgIn);
        IODGear(registry.gear(id).token).mint(to, tokens);
        governor.onBuy(id, tokens, usdgIn, spreadUsdg);
    }

    function sell(bytes32 id, address from, address to, uint256 tokens, uint256 usdgOut, uint256 spreadUsdg)
        external
        returns (bool paid)
    {
        IODGear(registry.gear(id).token).burn(from, tokens);
        paid = governor.onSell(id, tokens, spreadUsdg, to, usdgOut);
    }

    function payOut(address to, uint256 usdgOut) external returns (bool) {
        return governor.onSell(bytes32(0), 0, 0, to, usdgOut);
    }

    function payOutWithGas(address to, uint256 usdgOut, uint256 gasLimit) external returns (bool) {
        return governor.onSell{gas: gasLimit}(bytes32(0), 0, 0, to, usdgOut);
    }

    function toll(bytes32 id, int256 v) external {
        governor.onToll(id, v);
    }

    function normState(bytes32 id) external view returns (NormState memory s) {
        s.nf = uint128(nfOf[id]);
    }

    function valuePerToken(bytes32 id) external view returns (uint256, bool) {
        return (settledValue[id], true);
    }
}
