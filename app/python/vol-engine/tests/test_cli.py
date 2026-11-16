"""R16: the production entry point boots with the real env shape and writes intents for every listed key, sending nothing."""

from pathlib import Path

import psycopg
import pytest

from vol_engine.cli import main
from vol_engine.config import default_keys

from helpers import ORACLE

FIX = Path(__file__).parent / "fixtures"


def seed_all(url):
    """20 days of 5-minute rows ending now for every name (a deterministic wobble), straight into `prices`."""
    names = sorted({leg for k in default_keys() for leg in k.split("/")})
    with psycopg.connect(url, autocommit=True) as c:
        for n, sym in enumerate(names):
            c.execute(
                "INSERT INTO prices (underlying, ts, block, price_wad, session, fresh, source) "
                "SELECT %s, to_timestamp(t), 1, (100 * exp(0.002 * sin(t / 900.0 + %s) + 0.001 * sin(t / 77.0)) * 1e18)::numeric(78,0), "
                "'REGULAR', true, 'chainlink' FROM generate_series(floor(extract(epoch from now()) / 300)::bigint * 300 - 20 * 86400, "
                "floor(extract(epoch from now()) / 300)::bigint * 300, 300) AS t", (sym, n))


def prod_env(monkeypatch, url, **extra):
    for k in list(__import__("os").environ):
        if k.startswith("VOL_"):
            monkeypatch.delenv(k)
    env = {"NODE_ENV": "production", "DATABASE_URL": url, "VOL_SIGNER_KEYSTORE": str(FIX / "test.keystore.json"),
           "VOL_SIGNER_KEYSTORE_PASSWORD_FILE": str(FIX / "test.password"), "VOL_CHAIN_ID": "31337",
           "VOL_ORACLE_ADDRESS": ORACLE, **extra}
    for k, v in env.items():
        monkeypatch.setenv(k, v)


def test_cli_requires_a_mode():
    with pytest.raises(SystemExit):
        main(["post"])


def test_cli_needs_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["post", "--once"]) == 2


def test_cli_refuses_an_unknown_vol_variable(monkeypatch, capsys):
    monkeypatch.setenv("VOL_NOPE", "1")
    assert main(["post", "--once"]) == 78 and "VOL_NOPE" in capsys.readouterr().err


def test_post_once_boots_with_production_env_shape(pg, monkeypatch, capsys):
    seed_all(pg)
    prod_env(monkeypatch, pg)
    assert main(["post", "--once"]) == 0
    with psycopg.connect(pg) as c:
        rows = c.execute("SELECT key, status, sigma_bps, nonce, tx_hash, length(signature) FROM vol_post_intents").fetchall()
    keys = {r[0] for r in rows}
    assert keys == set(default_keys()) and len(rows) == len(default_keys())
    assert all(r[1] == "dry_run" and r[4] is None and r[5] == 132 for r in rows)      # signed, stored, sent nowhere
    assert all(500 <= r[2] <= 30_000 for r in rows)
    # explain prints every term for one key
    assert main(["explain", "NVDA/AMD"]) == 0
    out = capsys.readouterr().out
    assert "sigma_hat" in out and "NVDA/AMD" in out


def test_post_once_sends_nothing_even_with_an_rpc_configured_unless_send_is_exactly_1(pg, monkeypatch):
    seed_all(pg)
    prod_env(monkeypatch, pg, VOL_SEND="true")
    assert main(["post", "--once"]) == 0
    with psycopg.connect(pg) as c:
        assert c.execute("SELECT count(*) FROM vol_post_intents WHERE status <> 'dry_run'").fetchone()[0] == 0
