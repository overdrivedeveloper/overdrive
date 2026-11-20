import json
from pathlib import Path

import psycopg
import pytest

from risk_sim.cli import main

FIX = Path(__file__).parent / "fixtures" / "book_small.json"
AS_OF = 1794535200.0          # 2026-11-13T02:00:00Z, the fixture as_of


def env(monkeypatch, url, outbox, out, **extra):
    for k in ("RISK_MAX_LOSS_BPS", "RISK_WRITE_DATABASE_URL", "TELEGRAM_OUTBOX", "RISK_ONCHAIN_SHOCK_BPS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("TELEGRAM_OUTBOX", str(outbox))
    monkeypatch.setenv("RISK_OUT_DIR", str(out))
    for k, v in extra.items():
        monkeypatch.setenv(k, v)


def small_equity_fixture(tmp_path, equity):
    d = json.loads(FIX.read_text())
    d["equity_usd"] = equity
    p = tmp_path / "book.json"
    p.write_text(json.dumps(d))
    return p


def rows(url, sql, *a):
    with psycopg.connect(url) as c:
        return c.execute(sql, a).fetchall()


def test_failed_gate_is_recorded_not_raised(pg, tmp_path, monkeypatch):
    env(monkeypatch, pg, tmp_path / "tg.txt", tmp_path / "out")
    book = small_equity_fixture(tmp_path, 40_000.0)             # worst loss about 26k against a 6k limit
    assert main(["run", "--nightly", "--from-fixture", str(book), "--date", "2026-11-13"]) == 0
    run = rows(pg, "SELECT gate, offending_scenario, worst_loss_usd, plan IS NOT NULL FROM risk_runs")[0]
    assert run[0] == "fail" and run[1] and run[2] > 6_000 and run[3]
    plan = json.loads(rows(pg, "SELECT plan::text FROM risk_runs")[0][0])
    assert plan["worst_loss_usd"] <= 6_000 * (1 + 1e-9)                              # the plan that would pass
    assert "GATE FAIL" in (tmp_path / "tg.txt").read_text()
    assert (tmp_path / "out" / "2026-11-13" / "report.json").exists()


def test_stale_book_keeps_previous_plan(pg, tmp_path, monkeypatch):
    env(monkeypatch, pg, tmp_path / "tg.txt", tmp_path / "out")
    assert main(["run", "--nightly", "--from-fixture", str(FIX), "--date", "2026-11-12"]) == 0
    before = rows(pg, "SELECT gear, cap_usd FROM risk_caps ORDER BY gear")
    assert before
    # a day later the same book is 25 hours old: stale
    assert main(["run", "--nightly", "--from-fixture", str(FIX), "--date", "2026-11-13", "--now", str(AS_OF + 86_400)]) == 0
    assert rows(pg, "SELECT status, gate FROM risk_runs WHERE run_date = '2026-11-13'") == [("stale_inputs", "unknown")]
    assert rows(pg, "SELECT count(*) FROM risk_caps WHERE run_date = '2026-11-13'") == [(0,)]
    assert rows(pg, "SELECT gear, cap_usd FROM risk_caps ORDER BY gear") == before
    assert "stale inputs" in (tmp_path / "tg.txt").read_text()
    # a missing sigma is stale as well, and a stale rerun never erases a good run of the same date
    d = json.loads(FIX.read_text())
    d["sigma_bps"] = {}
    p = tmp_path / "nosigma.json"
    p.write_text(json.dumps(d))
    assert main(["run", "--nightly", "--from-fixture", str(p), "--date", "2026-11-12"]) == 0
    assert rows(pg, "SELECT status FROM risk_runs WHERE run_date = '2026-11-12'") == [("ok",)]


def seed_indexer(url, now_iso):
    with psycopg.connect(url, autocommit=True) as c:
        c.execute("INSERT INTO gears (id, market_a, underlying, power, power_wad, token, cap_usd, spread_bps, status) VALUES "
                  "('0xg2','0xm','TSLA',2,2000000000000000000,'0xt2',1000000000000,60,'active'),"
                  "('0xg15','0xm','TSLA',1.5,1500000000000000000,'0xt15',1000000000000,60,'active')")
        c.execute("INSERT INTO balances VALUES ('0xt2','0xh1',500000000000000000000000),('0xt2','0x0000000000000000000000000000000000000000',999),"
                  "('0xt15','0xh1',300000000000000000000000)")
        for g in ("0xg2", "0xg15"):
            c.execute("INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, side, tokens, usdg, value_per_token, via) "
                      "VALUES (%s,0,1,%s,%s,'0xh1','buy',1,1,1000000000000000000,'minter')", ("0x" + g, now_iso, g))
        c.execute("INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block) "
                  "VALUES (%s,'TSLA',1300000000000,0,1300000000000,400000000000,1500000000000,1)", (now_iso,))
        c.execute("INSERT INTO exit_reserve_log (ts, block, balance, \"floor\") VALUES (%s,1,1500000000000,50000000000)", (now_iso,))
        c.execute("INSERT INTO vol_posts VALUES ('TSLA',%s,1,'0xv',0,6500,NULL,NULL)", (now_iso,))
        c.execute("INSERT INTO prices (underlying, ts, price_wad) VALUES ('TSLA',%s,250000000000000000000)", (now_iso,))


def test_nightly_boots_with_real_env_shape(pg, tmp_path, monkeypatch):
    seed_indexer(pg, "2026-11-13T01:58:00Z")
    host = pg.rsplit("/", 1)[0].replace("risk@", "risk_ro@")
    env(monkeypatch, host + "/overdrive_lane18", tmp_path / "tg.txt", tmp_path / "out", RISK_WRITE_DATABASE_URL=pg)
    assert main(["run", "--nightly", "--now", str(AS_OF)]) == 0
    assert rows(pg, "SELECT status FROM risk_runs") == [("ok",)]
    assert rows(pg, "SELECT count(*) FROM risk_scenario_results") == [(8,)]
    assert rows(pg, "SELECT count(*) FROM risk_caps")[0][0] > 0
    assert rows(pg, "SELECT last_ok IS NOT NULL FROM service_status WHERE job = 'risk-sim'") == [(True,)]
    rep = json.loads((tmp_path / "out" / "2026-11-13" / "report.json").read_text())
    assert rep["equity_usd"] == 400_000.0
    # the read role cannot write
    with psycopg.connect(host + "/overdrive_lane18") as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("DELETE FROM risk_runs")


def test_pair_gear_sigma_is_found_under_the_oracle_pair_key(pg):
    """Regression: the oracle posts a pair's sigma under keccak256(abi.encode(a, b)); the book used to look for "ETH/BTC" and
    every nightly run went stale_inputs (sigma_missing:ETH/BTC) once a pair gear had traded."""
    from datetime import datetime, timezone

    from risk_sim.book import freshness, load_book, parse_ts

    eth = "0x" + "ETH".encode().hex().ljust(64, "0")
    btc = "0x" + "BTC".encode().hex().ljust(64, "0")
    pair = "0x53a0b92e86a2442720353fd0555f985c34c582969c5f45ba30cf5194eaff582d"  # not-a-key: the ETH/BTC oracle pair key
    now_iso = "2026-11-13T01:58:00Z"
    with psycopg.connect(pg, autocommit=True) as c:
        c.execute("INSERT INTO gears (id, market_a, market_b, underlying, underlying_b, power, power_wad, token, cap_usd, spread_bps, status) VALUES "
                  "('0xgp', %s, %s, 'ETH', 'BTC', 2, 2000000000000000000, '0xtp', 1000000000000, 60, 'active'),"
                  "('0xge', %s, NULL, 'ETH', NULL, 2, 2000000000000000000, '0xte', 1000000000000, 60, 'active')", (eth, btc, eth))
        c.execute("INSERT INTO balances VALUES ('0xtp','0xh1',1000000000000000000000),('0xte','0xh1',1000000000000000000000)")
        for g in ("0xgp", "0xge"):
            c.execute("INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, side, tokens, usdg, value_per_token, via) "
                      "VALUES (%s,0,1,%s,%s,'0xh1','buy',1,1,1000000000000000000,'minter')", ("0x" + g, now_iso, g))
        c.execute("INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block) "
                  "VALUES (%s,'ETH',0,0,0,400000000000,1500000000000,1)", (now_iso,))
        c.execute("INSERT INTO prices (underlying, ts, price_wad) VALUES ('ETH',%s,3000000000000000000000)", (now_iso,))
        # the indexer writes the event's bytes32 market lowercased: ETH's ASCII id, and the pair's hash
        c.execute("INSERT INTO vol_posts VALUES (%s,%s,1,'0xv1',0,6000,NULL,NULL),(%s,%s,1,'0xv2',0,4200,NULL,NULL)", (eth, now_iso, pair, now_iso))
    with psycopg.connect(pg) as c:
        book = load_book(c, datetime(2026, 11, 13, 2, 0, tzinfo=timezone.utc))
    assert sorted(g.key for g in book.gears) == ["ETH", "ETH/BTC"]
    assert book.sigma_bps["ETH/BTC"] == 4200.0 and book.sigma_bps["ETH"] == 6000.0
    assert not [r for r in freshness(book, parse_ts("2026-11-13T02:00:00Z"), 3600, 3600) if r.startswith("sigma_missing")]


def test_gear_stored_under_a_raw_market_id_matches_its_sigma(pg):
    """Regression (fork G07): a market listed after the deployment file was written was stored with its raw bytes32 id as the
    underlying, while vol_posts decode to the symbol, so the book reported sigma_missing and wrote no scenario rows."""
    from datetime import datetime, timezone

    from risk_sim.book import freshness, load_book, parse_ts

    mcka = "0x" + "MCKA".encode().hex().ljust(64, "0")
    now_iso = "2026-11-13T01:58:00Z"
    with psycopg.connect(pg, autocommit=True) as c:
        c.execute("INSERT INTO gears (id, market_a, market_b, underlying, underlying_b, power, power_wad, token, cap_usd, spread_bps, status) VALUES "
                  "('0xgm', %s, NULL, %s, NULL, 2, 2000000000000000000, '0xtm', 1000000000000, 60, 'active')", (mcka, mcka))
        c.execute("INSERT INTO balances VALUES ('0xtm','0xh1',1000000000000000000000)")
        c.execute("INSERT INTO trades (tx_hash, log_index, block, ts, gear, account, side, tokens, usdg, value_per_token, via) "
                  "VALUES ('0x0xgm',0,1,%s,'0xgm','0xh1','buy',1,1,1000000000000000000,'minter')", (now_iso,))
        c.execute("INSERT INTO governor_ledger (ts, underlying, delta, gamma, hedge_delta, equity, exit_reserve, block) "
                  "VALUES (%s,'MCKA',0,0,0,400000000000,1500000000000,1)", (now_iso,))
        c.execute("INSERT INTO prices (underlying, ts, price_wad) VALUES ('MCKA',%s,3000000000000000000000)", (now_iso,))
        c.execute("INSERT INTO vol_posts VALUES (%s,%s,1,'0xv1',0,5100,NULL,NULL)", (mcka, now_iso))
    with psycopg.connect(pg) as c:
        book = load_book(c, datetime(2026, 11, 13, 2, 0, tzinfo=timezone.utc))
    assert [g.key for g in book.gears] == ["MCKA"]
    assert book.sigma_bps["MCKA"] == 5100.0
    assert not [r for r in freshness(book, parse_ts("2026-11-13T02:00:00Z"), 3600, 3600) if r.startswith("sigma_missing")]


def test_nightly_with_an_empty_indexer_records_no_book_and_exits_zero(pg, tmp_path, monkeypatch):
    # the server log: "LookupError: no governor_ledger rows: the indexer has not run", exit 1, Restart=on-failure every 300 s
    host = pg.rsplit("/", 1)[0].replace("risk@", "risk_ro@")
    env(monkeypatch, host + "/overdrive_lane18", tmp_path / "tg.txt", tmp_path / "out", RISK_WRITE_DATABASE_URL=pg)
    assert main(["run", "--nightly", "--now", str(AS_OF)]) == 0
    assert rows(pg, "SELECT count(*) FROM risk_runs") == [(0,)]
    assert rows(pg, "SELECT count(*) FROM risk_caps") == [(0,)]
    assert rows(pg, "SELECT last_ok IS NULL, last_error FROM service_status WHERE job = 'risk-sim'") == [(True, "no_book")]
