"""R6, R7: short history never lowers the post; earnings dates only count when two sources agree."""

from datetime import date, datetime, timezone

from vol_engine.config import MAX_BUY_BLOCK_S, WEEKEND_GAP_DEFAULT, EARNINGS_MOVE_DEFAULT
from vol_engine.earnings import SOURCE_A, SOURCE_B, EarningsRow, block_window, reconcile, report_times
from vol_engine.surface import earnings_move, weekend_move

NOW = datetime(2026, 11, 10, 15, 0, tzinfo=timezone.utc)


def row(sym, d, src, session="unknown"):
    return EarningsRow(sym, date.fromisoformat(d), session, src)


def test_default_moves_flagged():
    e, flags = earnings_move("TSLA", [0.05, 0.04, 0.06])           # 3 reports: under 4
    assert e == EARNINGS_MOVE_DEFAULT["TSLA"] and flags == ["earnings_move_default"]
    e, flags = earnings_move("NVDA", [0.05, -0.04, 0.06, 0.07])    # 4 reports: the median
    assert flags == [] and abs(e - 0.055) < 1e-9
    g, flags = weekend_move("SPY", [0.01] * 25)                    # 25 weeks: under 26
    assert g == WEEKEND_GAP_DEFAULT["SPY"] and flags == ["weekend_move_default"]
    g, flags = weekend_move("SPY", [0.01 * (i + 1) for i in range(26)])
    assert flags == [] and abs(g - 0.235) < 1e-9
    # defaults are never below the observed typical move, so short history cannot lower a post
    assert earnings_move("AAPL", [])[0] >= 0.05


def test_two_sources_must_agree():
    agree = reconcile("NVDA", [row("NVDA", "2026-11-19", SOURCE_A), row("NVDA", "2026-11-20", SOURCE_B, "post")], NOW)
    assert agree.status == "confirmed" and agree.report_date == date(2026, 11, 19) and agree.session == "post"
    dis = reconcile("NVDA", [row("NVDA", "2026-11-19", SOURCE_A), row("NVDA", "2026-11-25", SOURCE_B)], NOW)
    assert dis.status == "disagree" and dis.force_block == (int(NOW.timestamp()), int(NOW.timestamp()) + 86_400)
    assert dis.alerts[0][0] == "earnings_sources_disagree" and len(dis.candidates) == 2
    far = reconcile("NVDA", [row("NVDA", "2027-03-19", SOURCE_A), row("NVDA", "2027-04-25", SOURCE_B)], NOW)
    assert far.status == "disagree" and far.force_block is None and far.alerts          # farther out: alert only
    one = reconcile("NVDA", [row("NVDA", "2026-11-19", SOURCE_A)], NOW)
    assert one.status == "missing_source" and one.report_date is None                  # a single source never confirms
    none = reconcile("NVDA", [], NOW)
    assert none.status == "none" and none.report_date is None and none.force_block is None
    assert reconcile("SPY", [], NOW).status == "no_earnings"


def test_block_window_within_contract_limits():
    ts, lo, hi = report_times(date(2026, 11, 19), "post")
    assert (ts - lo, hi - ts) == (3600, 1800)
    now = lo - 5 * 3600
    assert block_window(lo, hi, now) == (lo, hi)
    assert block_window(lo, hi, lo + 600) == (lo + 600, hi)       # never starts in the past
    assert block_window(lo, hi, hi + 1) == (0, 0)                 # a passed window is not posted
    ts2, lo2, hi2 = report_times(date(2026, 11, 19), "unknown")
    assert hi2 - lo2 < MAX_BUY_BLOCK_S
    f, t = block_window(0, 10**9, 1000)
    assert t - f <= MAX_BUY_BLOCK_S and f >= 1000
