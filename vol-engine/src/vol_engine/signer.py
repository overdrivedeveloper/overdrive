"""EIP-712 signing of ODVolOracle posts (domain "Overdrive Vol" v1; type VolPost, see IODVolOracle.sol and the shared vector
contracts/test/vectors/volpost-eip712.json, which app/src/lib/volpost.ts and ODVolOracle's own test read as well)."""

from __future__ import annotations

from dataclasses import dataclass

from eth_abi import encode
from eth_keys import keys
from eth_utils import keccak, to_checksum_address

DOMAIN_NAME = "Overdrive Vol"
DOMAIN_VERSION = "1"
POST_TYPE = "VolPost(bytes32 market,uint64 sigmaBps,uint64 buyBlockFrom,uint64 buyBlockTo,uint64 validUntil,uint64 nonce)"
DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
POST_TYPEHASH = keccak(text=POST_TYPE)
DOMAIN_TYPEHASH = keccak(text=DOMAIN_TYPE)
_U64 = (1 << 64) - 1
_SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141  # not-a-key: the curve order


MAX_SYMBOL_BYTES = 32


def market_key(symbol: str) -> bytes:
    """The deployment's market id: bytes32(bytes(symbol)), the UTF-8 symbol right-padded with zero bytes, exactly as
    contracts/script/lib/SystemConfig.sol sets `m.id` and app `marketId` builds it ("TSLA" -> 0x54534c41 00..00). The
    symbol's case is kept as given. Refuses what has no id: an empty symbol, a zero byte (the record's `symbolOf` would cut
    it there) and more than 32 bytes (Solidity would silently truncate it onto another market's id)."""
    raw = symbol.encode("utf-8")
    if not raw or len(raw) > MAX_SYMBOL_BYTES or b"\0" in raw:
        raise ValueError(f"market symbol {symbol!r} has no bytes32 id (1 to {MAX_SYMBOL_BYTES} bytes, no zero byte)")
    return raw.ljust(MAX_SYMBOL_BYTES, b"\0")


def pair_key(market_a: bytes, market_b: bytes) -> bytes:
    """keccak256(abi.encode(marketA, marketB)): the pair gear A over B (the oracle's `pairKey`)."""
    return keccak(encode(["bytes32", "bytes32"], [market_a, market_b]))


@dataclass(frozen=True)
class VolPost:
    market: bytes
    sigmaBps: int
    buyBlockFrom: int
    buyBlockTo: int
    validUntil: int
    nonce: int

    def __post_init__(self) -> None:
        if len(self.market) != 32:
            raise ValueError("market must be 32 bytes")
        for f in ("sigmaBps", "buyBlockFrom", "buyBlockTo", "validUntil", "nonce"):
            if not 0 <= getattr(self, f) <= _U64:
                raise ValueError(f"{f} does not fit uint64")

    def as_tuple(self) -> tuple:
        return (self.market, self.sigmaBps, self.buyBlockFrom, self.buyBlockTo, self.validUntil, self.nonce)

    def typed_data(self, chain_id: int, verifying_contract: str) -> dict:
        """The eth_signTypedData_v4 payload, same shape as the typedData block of the shared vector."""
        return {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
                ],
                "VolPost": [
                    {"name": "market", "type": "bytes32"}, {"name": "sigmaBps", "type": "uint64"},
                    {"name": "buyBlockFrom", "type": "uint64"}, {"name": "buyBlockTo", "type": "uint64"},
                    {"name": "validUntil", "type": "uint64"}, {"name": "nonce", "type": "uint64"},
                ],
            },
            "primaryType": "VolPost",
            "domain": {"name": DOMAIN_NAME, "version": DOMAIN_VERSION, "chainId": chain_id,
                       "verifyingContract": to_checksum_address(verifying_contract)},
            "message": {"market": "0x" + self.market.hex(), "sigmaBps": self.sigmaBps, "buyBlockFrom": self.buyBlockFrom,
                        "buyBlockTo": self.buyBlockTo, "validUntil": self.validUntil, "nonce": self.nonce},
        }


@dataclass(frozen=True)
class SignedPost:
    post: VolPost
    v: int  # 27 or 28
    r: bytes
    s: bytes
    digest: bytes

    @property
    def signature(self) -> bytes:
        """r || s || v, the byte layout ODVolOracle.post takes."""
        return self.r + self.s + bytes([self.v])


def domain_separator(chain_id: int, verifying_contract: str) -> bytes:
    return keccak(encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [DOMAIN_TYPEHASH, keccak(text=DOMAIN_NAME), keccak(text=DOMAIN_VERSION), chain_id,
         to_checksum_address(verifying_contract)],
    ))


def struct_hash(post: VolPost) -> bytes:
    return keccak(encode(["bytes32", "bytes32", "uint64", "uint64", "uint64", "uint64", "uint64"],
                         [POST_TYPEHASH, *post.as_tuple()]))


def digest(post: VolPost, chain_id: int, verifying_contract: str) -> bytes:
    return keccak(b"\x19\x01" + domain_separator(chain_id, verifying_contract) + struct_hash(post))


def sign_post(post: VolPost, chain_id: int, verifying_contract: str, key: str) -> SignedPost:
    """RFC 6979 deterministic ECDSA; eth-keys emits low-s only, which the contract requires."""
    dig = digest(post, chain_id, verifying_contract)
    sig = keys.PrivateKey(bytes.fromhex(key.removeprefix("0x"))).sign_msg_hash(dig)
    if sig.s > _SECP256K1_N // 2:  # defensive: never hand out a high-s signature
        raise RuntimeError("signer produced a high-s signature")
    return SignedPost(post, sig.v + 27, sig.r.to_bytes(32, "big"), sig.s.to_bytes(32, "big"), dig)


def signer_address(key: str) -> str:
    return keys.PrivateKey(bytes.fromhex(key.removeprefix("0x"))).public_key.to_checksum_address()


def recover(dig: bytes, signature: bytes) -> str:
    sig = keys.Signature(vrs=(signature[64] - 27, int.from_bytes(signature[:32], "big"),
                              int.from_bytes(signature[32:64], "big")))
    return sig.recover_public_key_from_msg_hash(dig).to_checksum_address()
