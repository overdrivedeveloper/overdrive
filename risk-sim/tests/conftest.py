"""Shared fixtures: a throwaway Postgres cluster on the lane port (5912, database overdrive_lane18) with the real 0000, 0001 and 0007 migrations."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
VECTORS = REPO / "contracts" / "test" / "vectors" / "index-vectors.json"
FIXTURES = Path(__file__).parent / "fixtures"
PG_BIN = next((Path(p) for p in ("/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@18/bin",
                                  "/usr/local/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin") if (Path(p) / "initdb").exists()), None)
DB_NAME = "overdrive_lane18"


@pytest.fixture(scope="session", autouse=True)
def copy_vectors():
    """R1: the vectors file shared with todos 03 and 16 is copied in by the test setup when present."""
    if VECTORS.exists():
        FIXTURES.mkdir(exist_ok=True)
        shutil.copyfile(VECTORS, FIXTURES / "index_vectors.json")


def _free_port(preferred: int) -> int:
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
    import psycopg

    d = tmp_path_factory.mktemp("pg")
    port = _free_port(5912)
    env = {**os.environ, "LC_ALL": "C"}
    subprocess.run([PG_BIN / "initdb", "-D", d / "data", "-U", "risk", "--auth=trust", "-E", "UTF8", "--locale=C"], check=True, capture_output=True, env=env)
    proc = subprocess.Popen([PG_BIN / "postgres", "-D", d / "data", "-p", str(port), "-c", "unix_socket_directories=", "-c", "listen_addresses=127.0.0.1"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    admin = f"postgres://risk@127.0.0.1:{port}/postgres"
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
    url = f"postgres://risk@127.0.0.1:{port}/{DB_NAME}"
    with psycopg.connect(url, autocommit=True) as c:
        for m in ("0000_base.sql", "0001_indexer.sql", "0007_risk_sim.sql"):
            c.execute((REPO / "app" / "drizzle" / m).read_text())
        c.execute("CREATE ROLE risk_ro LOGIN; GRANT SELECT ON ALL TABLES IN SCHEMA public TO risk_ro")

    def stop():
        proc.terminate()
        proc.wait(timeout=20)

    request.addfinalizer(stop)
    return url


@pytest.fixture()
def pg(pg_url):
    import psycopg

    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("TRUNCATE risk_runs, service_status, gears, balances, backer_vaults, trades, governor_ledger, exit_reserve_log, vol_posts, prices CASCADE")
    return pg_url
