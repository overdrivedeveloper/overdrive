import pytest

from helpers import mk
from risk_sim.exit_reserve import exit_run


def test_reserve_covers_or_gate_fails():
    gears = [("A", 2.0, 500_000.0), ("A", 1.5, 300_000.0), ("B", 2.0, 100_000.0), ("B", 0.5, 400_000.0)]
    book = mk(gears, reserve=2_000_000.0, equity=1e6)
    row, ok = exit_run(book, 0.187)
    stressed_a = 500_000 * 1.187**2 + 300_000 * 1.187**1.5
    assert row["largest_name"] == "A" and row["largest_cruise_sport_usd"] == pytest.approx(stressed_a)
    assert ok and row["largest_holder_sell_covered_usd"] == pytest.approx(2_000_000.0)       # reserve minus a zero floor
    # the floor eats into what can be paid; a reserve at or below the largest-name need fails the gate
    short = mk(gears, reserve=stressed_a + 10_000.0, equity=1e6, exit_reserve_floor_usd=50_000.0)
    row2, ok2 = exit_run(short, 0.187)
    assert not ok2 and row2["largest_holder_sell_covered_usd"] == pytest.approx(stressed_a - 40_000.0)
    # 25% of the total can bind instead of the largest name
    many = mk([(f"N{i}", 2.0, 100_000.0) for i in range(10)], reserve=1_100_000.0, equity=1e6)
    assert exit_run(many, 0.187)[1] is False or exit_run(many, 0.187)[0]["required_usd"] >= 0.25 * exit_run(many, 0.187)[0]["stressed_total_usd"]
