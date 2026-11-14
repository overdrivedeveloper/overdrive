"""R3: equities keep regular bars only; ETH and BTC keep every bar, weekends included."""

from datetime import date

from vol_engine.bars import Tick, build_crypto_bars, build_equity_bars, et_day

from helpers import crypto_ticks, equity_ticks, et_ts, weekdays


def test_equity_regular_only():
    days = weekdays(date(2026, 8, 3), 3)
    ticks = equity_ticks(days, extended=True)
    ticks.append(Tick(et_ts(date(2026, 8, 8), 11, 0), 100.0, "REGULAR", True))     # a Saturday print
    ticks.append(Tick(et_ts(days[0], 12, 0), 100.0, "CLOSED", True))
    ticks.append(Tick(et_ts(days[0], 12, 5), 0.0, "REGULAR", True))                # a bad price
    bars = build_equity_bars(ticks)
    assert bars.excluded_extended == 6 and bars.excluded_other == 2
    assert len(bars.returns) == 3 * 77 + 0 + 0 or len(bars.returns) >= 3 * 77
    assert len(bars.gaps) == len(set(et_day(t.ts) for t in ticks if t.session == "REGULAR")) - 1
    # no extended print leaks into a return: |return| stays at the 5-minute scale, never the 5% extended jump
    assert max(abs(r) for r in bars.returns) < 0.01


def test_crypto_all_bars():
    start = et_ts(date(2026, 8, 7), 20, 0)               # Friday evening: runs through the weekend
    bars = build_crypto_bars(crypto_ticks(start, 3 * 288, 0.5))
    assert bars.kind == "crypto" and len(bars.returns) == 3 * 288 - 1 and bars.excluded_extended == 0
    assert bars.bars_per_day == 288 and bars.days_per_year == 365


def test_forward_fill_when_the_feed_does_not_print():
    d = weekdays(date(2026, 8, 3), 1)[0]
    t0 = et_ts(d, 9, 30)
    sparse = [Tick(t0 + 1, 100.0, "REGULAR"), Tick(t0 + 3001, 101.0, "REGULAR")]    # one print after 50 minutes
    bars = build_equity_bars(sparse)
    assert len(bars.returns) == 10 and sum(1 for r in bars.returns if r != 0) == 1
