// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

struct VolPost {
    bytes32 market;
    uint64 sigmaBps;
    uint64 buyBlockFrom;
    uint64 buyBlockTo;
    uint64 validUntil;
    uint64 nonce;
}

struct VolReading {
    uint64 sigmaBps;
    uint64 postedAt;
    uint64 validUntil;
    uint64 buyBlockFrom;
    uint64 buyBlockTo;
    bool stale;
    bool hardStale;
}

interface IODVolOracle {
    event VolPosted(bytes32 indexed market, uint64 sigmaBps, uint64 validUntil, uint64 nonce);
    event SignerSet(address indexed signer);
    error BadSignature();
    error StepTooLarge(uint64 prior, uint64 next);
    error OutOfBounds(uint64 sigmaBps);
    error Expired();
    error NonceUsed(uint64 nonce);
    error TooSoon(uint64 nextAt);
    function post(VolPost calldata p, bytes calldata sig) external; // anyone relays a signer's post
    function setSigner(address signer) external; // admin
    function revokeSigner() external; // guardian
    function setBounds(bytes32 market, uint64 floorBps, uint64 ceilingBps) external; // admin
    function read(bytes32 market) external view returns (VolReading memory);
    function signer() external view returns (address);
    function domainSeparator() external view returns (bytes32);
}
