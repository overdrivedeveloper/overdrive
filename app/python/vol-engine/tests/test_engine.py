from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from vol_engine.bars import ET, Tick
from vol_engine.config import MAX_TICK_AGE_S, Settings
from vol_engine.earnings import SOURCE_A, SOURCE_B, EarningsRow
from vol_engine.engine import ClockError, explain, plan_pass, resolve_now, run_pass
from vol_engine.guard import ChainState
from vol_engine.history import History
from vol_engine.markets import resolve
from vol_engine.sender import DryRunSender
from vol_engine.store import MemoryStore

from helpers import ANVIL_KEY, CHAIN_ID, ORACLE, FakeOracle, crypto_ticks, equity_ticks, et_ts, weekdays

T0 = 1_760_000_000.0
N = 20 * 288


def settings(*keys, **kw):
    return Settings(signer_key=ANVIL_KEY, oracle_address=ORACLE, chain_id=CHAIN_ID, keys=keys or ("ETH",), **kw)


def eth_store(vol=0.6, seed=2):
    st = MemoryStore()
    st.tick_rows["ETH"] = crypto_ticks(T0, N, vol, seed=seed)
    return st, T0 + 300 * N - 300 + 60


def test_stale_prices_skip_not_lower():
    st, now = eth_store()
    oracle = FakeOracle()
    first = plan_pass(now, settings(), st, History(), oracle)
    assert len(first) == 1
    oracle.accept(first[0], int(now))
    # the feed dies: 26 minutes without a row. No post for the key, an alert, and nothing lower is ever planned
    later = now + MAX_TICK_AGE_S + 120
    assert plan_pass(later, settings(), st, History(), oracle, force=True) == []
    assert [a["kind"] for a in st.alerts] == ["stale_prices"]
    assert oracle.state(first[0].market).sigma_bps == first[0].sigma_bps          # the old post keeps pricing
    # a repeat of the same alert inside six hours is folded, not duplicated
    plan_pass(later + 60, settings(), st, History(), oracle, force=True)
    assert len(st.alerts) == 1 and st.alerts[0]["repeated_at"] is not None


def test_cadence_validity_and_nonce():
    st, now = eth_store()
    s = settings()
    oracle = FakeOracle()
    first = plan_pass(now, s, st, History(), oracle)[0]
    assert first.nonce == 1 and 300 <= first.valid_until - now <= 7200 and first.valid_until - now == 3600
    oracle.accept(first, int(now))
    # inside 30 s of the last post: nothing, even when forced
    assert plan_pass(now + 20, s, st, History(), oracle, force=True) == []
    # after 30 s but under a 1% change with plenty of validity left: nothing
    assert plan_pass(now + 60, s, st, History(), oracle) == []
    # inside 25% of the validity left: a renewal even without a change, with the next nonce read from the oracle
    renew = now + 3600 - 600
    st.tick_rows["ETH"] += [Tick(t.ts + 300 * N, t.price, "REGULAR") for t in st.tick_rows["ETH"][-3:]]  # keep prices fresh
    second = plan_pass(renew, s, st, History(), oracle)
    assert len(second) == 1 and second[0].nonce == 2
    # the nonce comes from lastNonce, never a guess: after a post made elsewhere (nonce 9) the next is 10
    oracle.states[first.market] = ChainState(first.sigma_bps, int(now), first.valid_until, 9)
    assert plan_pass(renew, s, st, History(), oracle)[0].nonce == 10
    # validity is clamped inside the contract window whatever the environment says
    for v in (10, 100_000):
        it = plan_pass(now, Settings(**{**s.__dict__, "validity_s": v}), st, History(), FakeOracle())[0]
        assert 300 + 30 <= it.valid_until - now <= 7200 - 60


def test_chain_clock():
    block = {"timestamp": hex(1_900_000_000)}
    tr = lambda method, params: block  # noqa: E731
    chain = Settings(clock="chain", rpc_url="http://x")
    assert resolve_now(chain, tr) == 1_900_000_000.0
    wall = Settings(clock="wall", rpc_url="http://x")
    with pytest.raises(ClockError, match="VOL_CLOCK=chain"):
        resolve_now(wall, tr, wall=lambda: 1_800_000_000.0)       # a warped fork: the chain is far ahead
    assert resolve_now(wall, tr, wall=lambda: 1_900_000_100.0) == 1_900_000_100.0
    assert resolve_now(Settings(), tr, wall=lambda: 5.0) == 5.0   # no RPC: nothing to compare
    # validUntil lands in the warped chain's future with the chain clock
    st = MemoryStore()
    st.tick_rows["ETH"] = crypto_ticks(1_900_000_000 - 300 * N, N, 0.6)
    it = plan_pass(1_900_000_000.0, settings(), st, History(), FakeOracle())[0]
    assert 1_900_000_000 + 300 <= it.valid_until <= 1_900_000_000 + 7200


def nvda_store(now_d: date, extra_closed=None):
    st = MemoryStore()
    days = weekdays(now_d - timedelta(days=40), 25)
    ticks = equity_ticks([d for d in days if d <= now_d], seed=9, bar_vol=0.0012)
    st.tick_rows["NVDA"] = ticks
    return st, ticks


def test_earnings_bump_ramps_in_and_blocks_buys():
    d = date(2026, 11, 18)                                   # a Wednesday
    st, ticks = nvda_store(d)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 11, 19), "post", SOURCE_A),
                        EarningsRow("NVDA", date(2026, 11, 19), "post", SOURCE_B)]
    s = settings("NVDA")
    base_now = ticks[-1].ts + 60                              # 16:00 ET the day before: report is 24 h away
    far = plan_pass(base_now, s, st, History(), FakeOracle(), force=True)[0]
    assert "earnings_bump" not in far.flags and far.buy_block_to > far.buy_block_from > 0     # the window is posted early
    hi = et_ts(date(2026, 11, 19), 16, 5)
    # an hour before the report the weight is near 1: sigma is above the no-event value, with the default-move flag
    near_now = hi - 3600
    st.tick_rows["NVDA"] += [Tick(near_now - 60, ticks[-1].price, "REGULAR")]
    near = plan_pass(near_now, s, st, History(), FakeOracle(), force=True)[0]
    assert "earnings_bump" in near.flags and "earnings_move_default" in near.flags
    assert near.sigma_bps > far.sigma_bps * 1.2
    assert near.buy_block_from == int(near_now) and near.buy_block_to == int(hi + 1800)


def test_disagreement_posts_higher_reading_and_blocks_a_day():
    d = date(2026, 11, 18)
    st, ticks = nvda_store(d)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 11, 19), "post", SOURCE_A),
                        EarningsRow("NVDA", date(2026, 12, 3), "post", SOURCE_B)]
    near_now = et_ts(date(2026, 11, 19), 15, 0)
    st.tick_rows["NVDA"] += [Tick(near_now - 60, ticks[-1].price, "REGULAR")]
    it = plan_pass(near_now, settings("NVDA"), st, History(), FakeOracle(), force=True)[0]
    assert it.buy_block_from == int(near_now) and it.buy_block_to == int(near_now) + 86_400
    assert "earnings_disagree" in it.flags and "earnings_bump" in it.flags             # the Nov 19 reading is the higher one
    assert any(a["kind"] == "earnings_sources_disagree" for a in st.alerts)


def test_weekend_bump_only_while_closed():
    d = date(2026, 11, 13)                                    # Friday
    st, ticks = nvda_store(d)
    friday_close = ticks[-1].ts
    s = settings("NVDA")
    weekday = plan_pass(friday_close + 60, s, st, History(), FakeOracle(), force=True)[0]
    sat = et_ts(date(2026, 11, 14), 12, 0)
    st.tick_rows["NVDA"] += [Tick(t, ticks[-1].price, "CLOSED", False) for t in range(int(friday_close) + 300, int(sat) + 1, 600)]
    weekend = plan_pass(sat, s, st, History(), FakeOracle(), force=True)[0]
    assert "weekend_bump" in weekend.flags and "weekend_move_default" in weekend.flags
    assert weekend.sigma_bps > weekday.sigma_bps


def test_extended_prints_flagged_and_dropped():
    d = date(2026, 11, 13)
    st = MemoryStore()
    days = weekdays(d - timedelta(days=40), 30)
    st.tick_rows["NVDA"] = equity_ticks([x for x in days if x <= d], extended=True)
    it = plan_pass(st.tick_rows["NVDA"][-1].ts + 60, settings("NVDA"), st, History(), FakeOracle(), force=True)
    assert it and any(f.startswith("extended_hours_excluded") for f in it[0].flags)


def test_run_pass_dry_run_by_default_and_explain():
    st, now = eth_store()
    out = run_pass(now, settings(), st, DryRunSender(), History(), FakeOracle(), force=True)
    assert [i.status for i in out] == ["dry_run"] and st.intents[0].signature.startswith("0x") and len(st.intents[0].signature) == 132
    text = explain("ETH", now, settings(), st, History(), FakeOracle())
    for term in ("sigma_fast", "sigma_slow", "markup", "floor", "sigma_hat", "flags"):
        assert term in text
    with pytest.raises(RuntimeError, match="signer"):
        run_pass(now, Settings(keys=("ETH",)), st, DryRunSender(), History(), FakeOracle(), force=True)


def test_floor_applies_with_no_usable_history():
    st = MemoryStore()
    st.tick_rows["SPY"] = [Tick(T0, 500.0, "REGULAR")]
    it = plan_pass(T0 + 60, settings("SPY"), st, History(), FakeOracle(), force=True)[0]
    assert it.sigma_bps == 1500 and "insufficient_bars" in it.flags      # D22: the SPY floor is 15%


def test_oracle_floor_above_engine_floor_clamps():
    st, now = eth_store(vol=0.2)
    o = FakeOracle()
    o.floor = 5500
    it = plan_pass(now, settings(), st, History(), o)[0]
    assert it.sigma_bps == 5500 and "clamped" in it.flags
