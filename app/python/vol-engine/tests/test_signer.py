"""R1: the signer reproduces the contract's EIP-712 vector byte for byte (the file ODVolOracle's test and app/test/volpost.test.ts read)."""

import json
from pathlib import Path

import pytest

from vol_engine.signer import (DOMAIN_TYPEHASH, POST_TYPEHASH, SignedPost, VolPost, digest, domain_separator, market_key,
                               pair_key, recover, sign_post, signer_address, struct_hash)

from helpers import ANVIL_KEY

VECTOR = Path(__file__).resolve().parents[4] / "contracts/test/vectors/volpost-eip712.json"
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141  # not-a-key: the curve order


def load():
    v = json.loads(VECTOR.read_text())
    m = v["typedData"]["message"]
    post = VolPost(bytes.fromhex(m["market"][2:]), m["sigmaBps"], m["buyBlockFrom"], m["buyBlockTo"], m["validUntil"], m["nonce"])
    return v, post, v["typedData"]["domain"]


def test_matches_contract_vector():
    v, post, dom = load()
    assert "0x" + POST_TYPEHASH.hex() == v["typeHash"]
    assert "0x" + domain_separator(dom["chainId"], dom["verifyingContract"]).hex() == v["domainSeparator"]
    assert "0x" + struct_hash(post).hex() == v["structHash"]
    signed = sign_post(post, dom["chainId"], dom["verifyingContract"], ANVIL_KEY)
    assert "0x" + signed.digest.hex() == v["digest"]
    assert "0x" + signed.signature.hex() == v["signature"]
    assert signer_address(ANVIL_KEY) == v["signer"] == recover(signed.digest, signed.signature)
    assert post.typed_data(dom["chainId"], dom["verifyingContract"])["message"]["market"] == v["typedData"]["message"]["market"]
    assert "0x" + DOMAIN_TYPEHASH.hex()  # the standard EIP712Domain type


def test_digest_equals_the_app_builder():
    """app/src/lib/volpost.ts hashes the same typed data with viem; its test asserts the same vector digest."""
    v, post, dom = load()
    assert "0x" + digest(post, dom["chainId"], dom["verifyingContract"]).hex() == v["digest"]


def test_domain_binds_chain_id():
    v, post, dom = load()
    a = sign_post(post, 31337, dom["verifyingContract"], ANVIL_KEY)
    b = sign_post(post, 4663, dom["verifyingContract"], ANVIL_KEY)
    assert a.digest != b.digest and a.signature != b.signature
    # the fork signature does not recover the signer over the mainnet digest
    assert recover(b.digest, a.signature) != signer_address(ANVIL_KEY)
    assert recover(b.digest, b.signature) == signer_address(ANVIL_KEY)
    other = sign_post(post, 31337, "0x00000000000000000000000000000000000f0d02", ANVIL_KEY)
    assert other.digest != a.digest


def test_low_s_only():
    _, post, dom = load()
    for nonce in range(1, 80):
        p = VolPost(post.market, 4000 + nonce, 0, 0, post.validUntil, nonce)
        s = sign_post(p, 31337, dom["verifyingContract"], ANVIL_KEY)
        assert int.from_bytes(s.s, "big") <= N // 2
        assert s.v in (27, 28) and len(s.signature) == 65


def test_market_keys():
    # The deployment's id (bytes32(bytes(symbol)), `cast format-bytes32-string TSLA`), never keccak256(symbol).
    assert market_key("TSLA") == bytes.fromhex("54534c41" + "00" * 28)
    ab, ba = pair_key(market_key("NVDA"), market_key("AMD")), pair_key(market_key("AMD"), market_key("NVDA"))
    assert ab != ba and len(ab) == 32


def test_uint64_range_enforced():
    with pytest.raises(ValueError):
        VolPost(market_key("X"), 2**64, 0, 0, 0, 1)
    with pytest.raises(ValueError):
        VolPost(b"short", 1, 0, 0, 0, 1)
