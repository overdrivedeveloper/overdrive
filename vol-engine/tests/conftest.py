"""Shared fixtures: a throwaway Postgres cluster (the lane's port 5512) and a local anvil (8625). Both skip when the tools are missing."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[2]
PG_BIN = next((Path(p) for p in ("/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@18/bin",
                                  "/usr/local/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin") if (Path(p) / "initdb").exists()), None)
MIGRATION = ROOT / "app" / "drizzle" / "0002_vol_engine.sql"
PG_PORT, ANVIL_PORT = 5512, 8625
DB_NAME = "overdrive_lane15"

# The three tables this lane reads from the indexer schema (todo 13, app/drizzle/0001_indexer.sql), reproduced for the fixture.
BASE_DDL = """
CREATE TABLE prices (underlying text NOT NULL, ts timestamptz NOT NULL, block bigint, price_wad numeric(78,0) NOT NULL,
  session text, fresh boolean NOT NULL DEFAULT true, source text, multiplier_wad numeric(78,0), PRIMARY KEY (underlying, ts));
CREATE TABLE vol_posts (gear_or_underlying text NOT NULL, ts timestamptz NOT NULL, block bigint NOT NULL, tx_hash text NOT NULL,
  log_index integer NOT NULL, sigma_bps numeric(78,0) NOT NULL, valid_until timestamptz, signer text, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE service_status (job text PRIMARY KEY, last_run timestamptz, last_ok timestamptz, last_error text, last_tx text,
  meta jsonb NOT NULL DEFAULT '{}');
"""


def free_port(preferred: int) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def pg_url(tmp_path_factory, request):
    if PG_BIN is None:
        pytest.skip("needs local postgres binaries")
    d = tmp_path_factory.mktemp("pg")
    port = free_port(PG_PORT)
    env = {**os.environ, "LC_ALL": "C"}
    subprocess.run([PG_BIN / "initdb", "-D", d / "data", "-U", "vol", "--auth=trust", "-E", "UTF8", "--locale=C"],
                   check=True, capture_output=True, env=env)
    proc = subprocess.Popen([PG_BIN / "postgres", "-D", d / "data", "-p", str(port), "-c", "unix_socket_directories=",
                             "-c", "listen_addresses=127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    import psycopg

    admin = f"postgres://vol@127.0.0.1:{port}/postgres"
    for _ in range(100):
        try:
            conn = psycopg.connect(admin, autocommit=True)
            break
        except Exception:
            time.sleep(0.2)
    else:
        proc.terminate()
        pytest.fail("postgres did not start")
    conn.execute(f"CREATE DATABASE {DB_NAME}")
    conn.close()
    url = f"postgres://vol@127.0.0.1:{port}/{DB_NAME}"
    with psycopg.connect(url, autocommit=True) as c:
        c.execute(BASE_DDL)
        c.execute(MIGRATION.read_text())

    def stop():
        proc.terminate()
        proc.wait(timeout=20)

    request.addfinalizer(stop)
    return url


@pytest.fixture()
def pg(pg_url):
    """A clean database per test: the engine's tables and the inputs are emptied."""
    import psycopg

    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("TRUNCATE prices, vol_posts, earnings_dates, vol_post_intents, vol_alerts RESTART IDENTITY")
    return pg_url


ANVIL = shutil.which("anvil") or str(Path.home() / ".foundry/bin/anvil")
CAST = shutil.which("cast") or str(Path.home() / ".foundry/bin/cast")
ARTIFACT = ROOT / "contracts" / "out" / "ODVolOracle.sol" / "ODVolOracle.json"
needs_anvil = pytest.mark.skipif(not (ARTIFACT.exists() and Path(ANVIL).exists() and Path(CAST).exists()),
                                 reason="needs anvil, cast and forge build output")


def cast(*args: str) -> str:
    return subprocess.run([CAST, *args], capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture()
def chain(request):
    """A local anvil at chain id 31337 starting at a fixed instant; returns the RPC url."""
    port = free_port(ANVIL_PORT)
    start = 1_790_000_000
    proc = subprocess.Popen([ANVIL, "--port", str(port), "--chain-id", "31337", "--timestamp", str(start), "--silent"])
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            cast("block-number", "--rpc-url", url)
            break
        except subprocess.CalledProcessError:
            time.sleep(0.2)

    def stop():
        proc.terminate()
        proc.wait(timeout=10)

    request.addfinalizer(stop)
    return url


@pytest.fixture(scope="session", autouse=True)
def throwaway_keystore():
    """tests/fixtures/test.keystore.json + test.password: anvil's well-known dev key encrypted at setup, never a real key.
    The acceptance command points the CLI at these two files."""
    import json

    from eth_account import Account

    from helpers import ANVIL_KEY

    d = Path(__file__).parent / "fixtures"
    d.mkdir(exist_ok=True)
    ks, pw = d / "test.keystore.json", d / "test.password"
    for p in (ks, pw):
        if p.exists():
            os.chmod(p, 0o640)
    pw.write_text("throwaway-test-password\n")
    ks.write_text(json.dumps(Account.encrypt(ANVIL_KEY, "throwaway-test-password", kdf="scrypt", iterations=2**4)))
    os.chmod(ks, 0o440)
    os.chmod(pw, 0o440)
    return ks, pw
