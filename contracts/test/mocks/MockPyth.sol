// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Pyth Core read surface: getPriceUnsafe and getPriceNoOlderThan, settable publishTime and expo.
contract MockPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    error StalePrice();
    error PriceFeedNotFound();

    mapping(bytes32 => Price) private _prices;
    mapping(bytes32 => bool) public known;

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _prices[id] = Price(price, conf, expo, publishTime);
        known[id] = true;
    }

    function setPublishTime(bytes32 id, uint256 publishTime) external {
        _prices[id].publishTime = publishTime;
    }

    function setExpo(bytes32 id, int32 expo) external {
        _prices[id].expo = expo;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        if (!known[id]) revert PriceFeedNotFound();
        return _prices[id];
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory) {
        if (!known[id]) revert PriceFeedNotFound();
        Price memory p = _prices[id];
        if (block.timestamp > p.publishTime && block.timestamp - p.publishTime > age) revert StalePrice();
        return p;
    }
}
