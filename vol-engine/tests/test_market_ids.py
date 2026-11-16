"""The engine posts under the market ids a deployment's oracles read: bytes32(bytes(symbol)) right-padded (SystemConfig.sol
`m.id`, app `marketId`), and pair gears under keccak256(abi.encode(idA, idB)). The vectors come from cast and are shared
with VolOracle.t.sol::test_MarketIdVectorsMatch and app/scripts/fork/fork.test.ts (contracts/test/vectors/market-ids.json)."""

import json
from pathlib import Path

import pytest

from vol_engine.cli import main
from vol_engine.config import Settings, parse_vol_keys
from vol_engine.keystore import KeyConfigError
from vol_engine.markets import check_deployment, resolve
from vol_engine.signer import market_key, pair_key

VECTOR = Path(__file__).resolve().parents[2] / "contracts/test/vectors/market-ids.json"
# cast format-bytes32-string TSLA / NVDA
TSLA_ID = "0x54534c4100000000000000000000000000000000000000000000000000000000"  # not-a-key: market id
NVDA_ID = "0x4e56444100000000000000000000000000000000000000000000000000000000"  # not-a-key: market id
# cast keccak $(cast abi-encode "f(bytes32,bytes32)" $NVDA_ID $TSLA_ID)
NVDA_TSLA = "0xbb849ac03d897852484edb1c16f5191f2061f18cdd7f857b5308c577465db2e2"  # not-a-key: market id


def test_market_key_matches_cast_vectors():
    assert "0x" + market_key("TSLA").hex() == TSLA_ID
    assert "0x" + market_key("NVDA").hex() == NVDA_ID
    assert "0x" + pair_key(market_key("NVDA"), market_key("TSLA")).hex() == NVDA_TSLA
    assert resolve("TSLA").hex == TSLA_ID
    assert resolve("nvda/tsla").hex == NVDA_TSLA


def test_market_key_matches_shared_vector_file():
    vec = json.loads(VECTOR.read_text())
    for m in vec["markets"]:
        assert "0x" + market_key(m["symbol"]).hex() == m["id"], m["symbol"]
        assert resolve(m["symbol"]).hex == m["id"]
    for p in vec["pairs"]:
        assert "0x" + pair_key(market_key(p["a"]), market_key(p["b"])).hex() == p["id"], p["key"]
        assert resolve(p["key"]).hex == p["id"]


def test_market_key_keeps_case_and_refuses_unmappable_symbols():
    assert market_key("stETH") == b"stETH".ljust(32, b"\0")       # case as given, like bytes32(bytes(symbol))
    assert market_key("A" * 32) == b"A" * 32
    for bad in ("", "A" * 33, "X\0Y"):
        with pytest.raises(ValueError):
            market_key(bad)


def test_startup_refuses_a_key_with_no_market_id():
    with pytest.raises(KeyConfigError):
        Settings.from_env({"VOL_KEYS": "NVDA," + "A" * 33})
    with pytest.raises(KeyConfigError):
        parse_vol_keys("NVDA/" + "B" * 33)
    keys, ov = parse_vol_keys("NVDA," + "A" * 33 + "=0x" + "11" * 32)   # an explicit override needs no symbol id
    assert keys == ("NVDA", "A" * 33) and ov == (("A" * 33, "0x" + "11" * 32),)


def test_pair_built_from_leg_overrides():
    a, b = "0x" + "aa" * 32, "0x" + "bb" * 32
    m = resolve("NVDA/TSLA", {"NVDA": a, "TSLA": b})
    assert m.market == pair_key(bytes.fromhex(a[2:]), bytes.fromhex(b[2:]))


def record(**extra):
    return {"markets": [{"symbol": "NVDA", "id": NVDA_ID}, {"symbol": "TSLA", "id": TSLA_ID}],
            "gears": [{"marketA": "NVDA", "marketB": None}, {"marketA": "NVDA", "marketB": "TSLA"}], **extra}


def test_check_deployment_ok_without_overrides():
    assert check_deployment(("NVDA", "TSLA", "NVDA/TSLA"), {}, record()) == []


def test_check_deployment_flags_wrong_key_and_missing_key():
    from eth_utils import keccak
    wrong = {"TSLA": "0x" + keccak(text="TSLA").hex()}   # the old keccak256(symbol) default
    probs = check_deployment(("NVDA", "TSLA", "NVDA/TSLA"), wrong, record())
    assert any(p.startswith("TSLA: engine key") for p in probs)
    assert any(p.startswith("NVDA/TSLA: engine key") for p in probs)   # the pair is built from the wrong leg id
    probs = check_deployment(("NVDA", "TSLA"), {}, record())
    assert probs == ["NVDA/TSLA: the deployment reads it but the engine does not post it (add it to VOL_KEYS)"]


def test_cli_check_keys(tmp_path, monkeypatch, capsys):
    f = tmp_path / "4663.json"
    f.write_text(json.dumps(record()))
    monkeypatch.setenv("VOL_KEYS", "NVDA,TSLA,NVDA/TSLA")
    assert main(["check-keys", str(f)]) == 0
    assert "check-keys: ok" in capsys.readouterr().out
    monkeypatch.setenv("VOL_KEYS", "NVDA,TSLA")
    assert main(["check-keys", str(f)]) == 1
    monkeypatch.setenv("VOL_KEYS", "NVDA," + "A" * 33)
    assert main(["check-keys", str(f)]) == 78
    assert main(["check-keys", str(tmp_path / "missing.json")]) == 78
