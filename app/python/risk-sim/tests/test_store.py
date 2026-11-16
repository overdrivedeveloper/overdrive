from pathlib import Path

import psycopg

from risk_sim.cli import main

FIX = Path(__file__).parent / "fixtures" / "book_small.json"


def test_rerun_replaces_same_date_rows(pg, tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", pg)
    monkeypatch.setenv("RISK_OUT_DIR", str(tmp_path))
    counts = []
    for _ in range(2):
        assert main(["run", "--nightly", "--from-fixture", str(FIX), "--date", "2026-11-13"]) == 0
        with psycopg.connect(pg) as c:
            counts.append(tuple(c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("risk_runs", "risk_scenario_results", "risk_caps")))
    assert counts[0] == counts[1] and counts[0][0] == 1 and counts[0][1] == 8 and counts[0][2] > 0
    with psycopg.connect(pg) as c:
        assert c.execute("SELECT count(*) FROM service_status WHERE job = 'risk-sim'").fetchone()[0] == 1
