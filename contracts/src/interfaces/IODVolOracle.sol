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
    /// @notice Emitted when a volatility post is accepted.
    /// @param market Market id (bytes32 symbol key).
    /// @param sigmaBps Volatility in basis points.
    /// @param validUntil Latest time the approval is valid.
    /// @param nonce Replay-protection nonce.
    event VolPosted(bytes32 indexed market, uint64 sigmaBps, uint64 validUntil, uint64 nonce);
    /// @notice Emitted when the signer is set.
    /// @param signer Address of the signer.
    event SignerSet(address indexed signer);
    /// @notice Reverts when the post signature is not from the signer.
    error BadSignature();
    /// @notice Reverts when the change from the prior value exceeds the allowed step.
    /// @param prior The prior value.
    /// @param next The next value.
    error StepTooLarge(uint64 prior, uint64 next);
    /// @notice Reverts when the value is outside the bounds of the market.
    /// @param sigmaBps Volatility in basis points.
    error OutOfBounds(uint64 sigmaBps);
    /// @notice Reverts when the post has expired.
    error Expired();
    /// @notice Reverts when the nonce was already used.
    /// @param nonce Replay-protection nonce.
    error NonceUsed(uint64 nonce);
    /// @notice Reverts when a post comes before the minimum interval.
    /// @param nextAt Earliest timestamp at which the action is allowed.
    error TooSoon(uint64 nextAt);
    /// @notice Submits a signed volatility post.
    /// @dev Anyone may relay a post signed by the signer. Reverts with BadSignature, Expired, NonceUsed, TooSoon,
    /// StepTooLarge, OutOfBounds or BadBuyBlockWindow.
    /// @param p The parameter struct.
    /// @param sig The signature bytes.
    function post(VolPost calldata p, bytes calldata sig) external; // anyone relays a signer's post
    /// @notice Sets the signer.
    /// @dev Admin only.
    /// @param signer Address of the signer.
    function setSigner(address signer) external; // admin
    /// @notice Revokes the signer.
    /// @dev Guardian only.
    function revokeSigner() external; // guardian
    /// @notice Sets the allowed range for a market.
    /// @dev Admin only. Reverts with InvalidBounds.
    /// @param market Market id (bytes32 symbol key).
    /// @param floorBps Lower bound in basis points.
    /// @param ceilingBps Upper bound in basis points.
    function setBounds(bytes32 market, uint64 floorBps, uint64 ceilingBps) external; // admin
    /// @notice Reads the volatility of a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return  The volatility reading.
    function read(bytes32 market) external view returns (VolReading memory);
    /// @notice Returns the signer.
    /// @return  The signer address.
    function signer() external view returns (address);
    /// @notice Returns the EIP-712 domain separator.
    /// @return  The domain separator.
    function domainSeparator() external view returns (bytes32);

    // Signer, bounds and digest details.
    /// @notice Emitted when the signer is revoked.
    /// @param signer Address of the signer.
    event SignerRevoked(address indexed signer);
    /// @notice Emitted when the bounds of a market are set.
    /// @param market Market id (bytes32 symbol key).
    /// @param floorBps Lower bound in basis points.
    /// @param ceilingBps Upper bound in basis points.
    event BoundsSet(bytes32 indexed market, uint64 floorBps, uint64 ceilingBps);
    /// @notice Reverts when the admin address is invalid.
    error InvalidAdmin();
    /// @notice Reverts when the signer address is invalid.
    error InvalidSigner();
    /// @notice Reverts when the bounds are inconsistent.
    /// @param floorBps Lower bound in basis points.
    /// @param ceilingBps Upper bound in basis points.
    error InvalidBounds(uint64 floorBps, uint64 ceilingBps);
    /// @notice Reverts when the buy-block window is invalid.
    /// @param from The source address.
    /// @param to The recipient address.
    error BadBuyBlockWindow(uint64 from, uint64 to);
    /// @notice Returns the last nonce used for a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return  The nonce.
    function lastNonce(bytes32 market) external view returns (uint64);
    /// @notice Returns the allowed range for a market.
    /// @param market Market id (bytes32 symbol key).
    /// @return floorBps  Lower bound in basis points.
    /// @return ceilingBps  Upper bound in basis points.
    function bounds(bytes32 market) external view returns (uint64 floorBps, uint64 ceilingBps);
    /// @notice Returns the EIP-712 digest of a post.
    /// @param p The parameter struct.
    /// @return  The digest to sign.
    function hashPost(VolPost calldata p) external view returns (bytes32);
}
