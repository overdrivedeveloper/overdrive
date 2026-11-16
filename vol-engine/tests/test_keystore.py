"""Keystore signers (todo 15): a raw key for development, an encrypted keystore plus password file for production."""

import json
import os

import pytest
from eth_account import Account

from vol_engine.config import Settings
from vol_engine.keystore import KeyConfigError, load_key
from vol_engine.logs import scrub
from vol_engine.signer import signer_address

from helpers import ANVIL_KEY, ANVIL_KEY_2

PASSWORD = "correct horse battery staple"  # // test-password
ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"  # // test-key address


@pytest.fixture()
def keys(tmp_path):
    """Anvil's well-known dev key encrypted at test time into a temp dir (never committed)."""
    ks = tmp_path / "vol-signer.json"
    pw = tmp_path / "vol-signer.password"
    # a cheap scrypt cost keeps the test fast; the format is the one cast writes
    ks.write_text(json.dumps(Account.encrypt(ANVIL_KEY, PASSWORD, kdf="scrypt", iterations=2**4)))
    pw.write_text(PASSWORD + "\n")
    os.chmod(ks, 0o440)
    os.chmod(pw, 0o440)
    return ks, pw


def env(ks, pw, **extra):
    return {"VOL_SIGNER_KEYSTORE": str(ks), "VOL_SIGNER_KEYSTORE_PASSWORD_FILE": str(pw), **extra}


def test_keystore_unlocks_to_the_same_key_as_the_raw_form(keys):
    ks, pw = keys
    assert load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, pw)) == ANVIL_KEY
    assert signer_address(load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, pw))) == ANVIL_ADDRESS
    assert load_key("VOL_SIGNER_KEY", "VOL_SIGNER", {"VOL_SIGNER_KEY": ANVIL_KEY}) == ANVIL_KEY
    assert load_key("VOL_SIGNER_KEY", "VOL_SIGNER", {"VOL_SIGNER_KEY": ANVIL_KEY[2:]}) == ANVIL_KEY
    assert load_key("VOL_SIGNER_KEY", "VOL_SIGNER", {}) == ""


def test_settings_loads_signer_and_sender_from_keystores_and_scrubs_them(keys):
    ks, pw = keys
    ks2 = ks.parent / "vol-sender.json"
    ks2.write_text(json.dumps(Account.encrypt(ANVIL_KEY_2, PASSWORD, kdf="scrypt", iterations=2**4)))
    os.chmod(ks2, 0o440)
    s = Settings.from_env(env(ks, pw, VOL_SENDER_KEYSTORE=str(ks2), VOL_SENDER_KEYSTORE_PASSWORD_FILE=str(pw)))
    assert s.signer_key == ANVIL_KEY and s.sender_key == ANVIL_KEY_2
    assert ANVIL_KEY not in repr(s)
    assert ANVIL_KEY[2:] not in scrub(f"boom {s.signer_key}", s.secrets())


def test_production_refuses_a_raw_key_and_accepts_the_keystore(keys):
    ks, pw = keys
    with pytest.raises(KeyConfigError) as e:
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", {"NODE_ENV": "production", "VOL_SIGNER_KEY": ANVIL_KEY})
    assert "keystore" in str(e.value) and ANVIL_KEY[2:] not in str(e.value)
    assert load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, pw, NODE_ENV="production")) == ANVIL_KEY


def test_production_refuses_world_readable_key_files(keys):
    ks, pw = keys
    os.chmod(pw, 0o644)
    with pytest.raises(KeyConfigError, match="readable by other users"):
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, pw, NODE_ENV="production"))
    assert load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, pw)) == ANVIL_KEY  # development does not check modes


def test_wrong_password_missing_files_and_bad_combinations_never_echo_secrets(keys, tmp_path):
    ks, pw = keys
    bad = tmp_path / "bad.password"
    bad.write_text("not the password\n")
    with pytest.raises(KeyConfigError) as e:
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, bad))
    assert "not the password" not in str(e.value) and "could not decrypt" in str(e.value)
    with pytest.raises(KeyConfigError, match="cannot read the keystore"):
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(tmp_path / "missing.json", pw))
    with pytest.raises(KeyConfigError, match="needs VOL_SIGNER_KEYSTORE_PASSWORD_FILE"):
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", {"VOL_SIGNER_KEYSTORE": str(ks)})
    with pytest.raises(KeyConfigError, match="not both"):
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(ks, pw, VOL_SIGNER_KEY=ANVIL_KEY))
    with pytest.raises(KeyConfigError, match="32 bytes"):
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", {"VOL_SIGNER_KEY": "0x1234"})
    garbage = tmp_path / "garbage.json"
    garbage.write_text("{\"hello\": 1}")
    with pytest.raises(KeyConfigError):
        load_key("VOL_SIGNER_KEY", "VOL_SIGNER", env(garbage, pw))


def test_cli_exits_78_on_a_bad_keystore_without_printing_the_key(keys, monkeypatch, capsys):
    from vol_engine.cli import main

    ks, pw = keys
    monkeypatch.setenv("VOL_SIGNER_KEYSTORE", str(ks))
    monkeypatch.delenv("VOL_SIGNER_KEYSTORE_PASSWORD_FILE", raising=False)
    monkeypatch.delenv("VOL_SIGNER_KEY", raising=False)
    assert main(["post", "--once"]) == 78
    err = capsys.readouterr().err
    assert "VOL_SIGNER_KEYSTORE_PASSWORD_FILE" in err and ANVIL_KEY[2:] not in err


def test_signer_and_sender_must_differ(keys):
    ks, pw = keys
    same = env(ks, pw, VOL_SENDER_KEYSTORE=str(ks), VOL_SENDER_KEYSTORE_PASSWORD_FILE=str(pw))
    with pytest.raises(KeyConfigError, match="must differ"):
        Settings.from_env(same)
    other = {"VOL_SIGNER_KEY": ANVIL_KEY, "VOL_SENDER_KEY": ANVIL_KEY_2}
    assert Settings.from_env(other).sender_key == ANVIL_KEY_2
    with pytest.raises(KeyConfigError, match="sender wallet"):
        Settings.from_env({"VOL_SIGNER_KEY": ANVIL_KEY, "VOL_SEND": "1"})


def test_production_refuses_raw_key():
    with pytest.raises(KeyConfigError, match="keystore"):
        Settings.from_env({"NODE_ENV": "production", "VOL_SIGNER_KEY": ANVIL_KEY})


def test_unknown_vol_variable_refuses_to_start():
    with pytest.raises(KeyConfigError, match="VOL_SEND_TYPO"):
        Settings.from_env({"VOL_SEND_TYPO": "1"})
    assert Settings.from_env({"VOL_SEND": "true"}).send is False  # only the exact string "1" sends


def test_the_shared_server_env_example_starts_the_engine():
    """Every VOL_* name in the server env.example is one the engine knows or deliberately ignores."""
    from pathlib import Path
    from vol_engine.config import FOREIGN_ENV, KNOWN_ENV
    example = Path(__file__).resolve().parents[2] / "app" / "scripts" / "server" / "env.example"
    names = {line.split("=", 1)[0].strip() for line in example.read_text().splitlines()
             if "=" in line and not line.lstrip().startswith("#")}
    vol = {n for n in names if n.startswith("VOL_")}
    assert "VOL_STALE_WARN_SECONDS" in vol
    assert not vol - KNOWN_ENV - FOREIGN_ENV
    assert not KNOWN_ENV & FOREIGN_ENV
    Settings.from_env({"VOL_STALE_WARN_SECONDS": "900"})
