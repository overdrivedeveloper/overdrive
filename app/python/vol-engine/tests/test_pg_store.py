"""PgStore against the throwaway Postgres (skipped without postgres binaries), with the real migration."""

from datetime import date, datetime, timezone

import psycopg
import pytest

from vol_engine.bars import Tick
from vol_engine.config import Settings
from vol_engine.engine import plan_pass, run_pass
from vol_engine.history import History
from vol_engine.markets import resolve
from vol_engine.sender import DryRunSender
from vol_engine.store import Intent, PgStore

from helpers import ANVIL_KEY, ORACLE, crypto_ticks

T0 = 1_760_000_000
N = 12 * 288


def seed_prices(url, symbol, ticks):
    with psycopg.connect(url, autocommit=True) as c:
        with c.cursor() as cur:
            cur.executemany("INSERT INTO prices (underlying, ts, block, price_wad, session, fresh, source) "
                            "VALUES (%s, to_timestamp(%s), 1, %s, %s, %s, 'chainlink')",
                            [(symbol, t.ts, int(t.price * 10**18), t.session, t.fresh) for t in ticks])


def test_reads_prices_and_plans(pg):
    ticks = crypto_ticks(T0, N, 0.6, seed=3)
    seed_prices(pg, "ETH", ticks)
    st = PgStore(pg)
    got = st.prices("ETH", resolve("ETH").hex, T0 - 10)
    assert len(got) == N and abs(got[-1].price - ticks[-1].price) / ticks[-1].price < 1e-9
    s = Settings(signer_key=ANVIL_KEY, oracle_address=ORACLE, chain_id=31337, keys=("ETH",))
    out = run_pass(ticks[-1].ts + 60, s, st, DryRunSender(), History(), force=True)
    assert [i.status for i in out] == ["dry_run"]
    with psycopg.connect(pg) as c:
        row = c.execute("SELECT market, key, sigma_bps, status, nonce, flags, length(signature) FROM vol_post_intents").fetchone()
    assert row[0] == resolve("ETH").hex and row[1] == "ETH" and row[3] == "dry_run" and row[4] == 1 and row[6] == 132
    st.close()


def test_reader_connection_is_read_only_at_the_server(pg):
    st = PgStore(pg)
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        st._reader.execute("DELETE FROM prices")
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        st._reader.execute("INSERT INTO vol_alerts (market, kind) VALUES ('x', 'y')")
    st.close()


def test_intents_alerts_and_chain_posts(pg):
    st = PgStore(pg)
    mk = resolve("NVDA/AMD")
    i = Intent(mk.hex, mk.key, 4500, 0, 0, T0 + 3600, 1, "sent", ["ramped"], "0xab", float(T0))
    iid = st.write_intent(i)
    assert st.last_intent(mk.hex).flags == ["ramped"] and st.pending_intents()[0].id == iid
    st.mark_intent(iid, "accepted")
    assert st.pending_intents() == [] and st.intent_reference(mk.hex, ("accepted",)).sigma_bps == 4500
    st.mark_intent(iid, "dropped")
    assert st.last_intent(mk.hex) is None
    assert st.write_alert(mk.hex, "stale_prices", {"a": 1}, T0) is True
    assert st.write_alert(mk.hex, "stale_prices", {"a": 1}, T0 + 60) is False       # folded
    assert st.write_alert(mk.hex, "stale_prices", {"a": 2}, T0 + 120) is True
    with psycopg.connect(pg) as c:
        assert c.execute("SELECT count(*) FROM vol_alerts").fetchone()[0] == 2
        assert c.execute("SELECT repeated_at IS NOT NULL FROM vol_alerts ORDER BY id LIMIT 1").fetchone()[0] is True
        c.execute("INSERT INTO vol_posts VALUES (%s, to_timestamp(%s), 5, '0x1', 0, 4200, to_timestamp(%s), '0xs')",
                  (mk.hex, T0, T0 + 3600))
        c.commit()
    cp = st.chain_post(mk.hex)
    assert cp[0] == 4200 and cp[1] == T0 and cp[2] == T0 + 3600
    st.close()


def test_earnings_dates_table(pg):
    with psycopg.connect(pg, autocommit=True) as c:
        c.execute("INSERT INTO earnings_dates (symbol, report_date, session, source) VALUES ('NVDA', current_date + 3, 'post', 'calendar')")
    rows = PgStore(pg).earnings("NVDA")
    assert len(rows) == 1 and rows[0].source == "calendar" and rows[0].session == "post"
