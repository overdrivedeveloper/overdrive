import json
from pathlib import Path

import pytest

from helpers import mk
from risk_sim import config as C
from risk_sim.book import load_fixture
from risk_sim.hedge_model import HedgeModel
from risk_sim.scenarios import SCENARIOS, Context, budget_flags, run_all, run_scenario

FIX = Path(__file__).parent / "fixtures" / "book_small.json"
H = HedgeModel()


def case(res, suffix):
    return max((c for c in res.cases if c["label"].endswith(suffix)), key=lambda c: c["loss"])


def test_single_stock_gap_hand_computed():
    book = load_fixture(FIX)
    res = run_scenario(book, SCENARIOS["single_stock_minus_18_7"], H)
    # By hand (delta 1,350,000 = 2x500k + 1.5x300k - 1x100k; exact gear values after -18.7% and +18.7%):
    #   down: hedge -252,450; gears 500k(0.813^2-1) + 300k(0.813^1.5-1) + 100k(1/0.813-1) = -226,598.15  => P&L -25,851.85
    #   up:   hedge +252,450; gears 500k(1.187^2-1) + 300k(1.187^1.5-1) + 100k(1/1.187-1) = +276,699.77  => P&L -24,249.77
    down, up = 25_851.85, 24_249.77
    held = [c for c in res.cases if c["label"].endswith("hedged_no_venue")]
    by = {c["label"].split(":")[1]: c["loss"] for c in held}
    assert by["-18.7%"] == pytest.approx(down, rel=0.02) and by["+18.7%"] == pytest.approx(up, rel=0.02)     # the mirror gap is reported
    unhedged_worst = max(c["loss"] for c in res.cases if c["label"].endswith("unhedged"))
    assert unhedged_worst > max(by.values()) * 5                                                           # strictly worse
    assert res.worst_loss >= max(by.values()) and "unhedged" not in res.worst_case


def test_split_day_value_unchanged_and_double_apply_loses():
    book = mk([("TSLA", 2.0, 500_000.0), ("TSLA", 1.5, 300_000.0), ("TSLA", -1.0, 100_000.0), ("NVDA", 2.0, 100_000.0)])
    res = run_scenario(book, SCENARIOS["split_day"], H)
    total = book.total_governor_value()
    good = [c for c in res.cases if c["label"].endswith(":correct")]
    bad = [c for c in res.cases if c["label"].endswith(":double_applied")]
    assert len(good) == 2 * 4 * 2 and len(bad) == len(good)                    # 2 stocks x 4 ratios x 2 feed kinds
    assert all(abs(c["value_change"]) <= 1e-9 * total for c in good)
    assert all(c["tag"] == "misconfig_demo" and not c["counts"] for c in bad)
    assert any(c["loss"] > 0 for c in bad)                                       # shows the loss if the multiplier were applied twice
    assert res.worst_loss <= 1e-6 and "misconfig_demo" in res.flags


def _write_candles(d: Path, rows, daily):
    d.mkdir(parents=True, exist_ok=True)
    for name, head, body in (("oct10_2025_5m.csv", "symbol,ts,open,high,low,close", rows), ("daily.csv", "symbol,date,open,high,low,close", daily)):
        (d / name).write_text("\n".join([head] + [",".join(str(x) for x in r) for r in body]) + "\n")


def test_replay_uses_data_files_and_prints_moves(tmp_path):
    rows = []
    price = {"ETH": 4000.0, "BTC": 120000.0}
    for i in range(24):
        for s in ("ETH", "BTC"):
            o = price[s]
            c = o * (0.97 if i % 4 == 0 else 1.001)
            rows.append((s, f"2025-10-10T{i // 12:02d}:{(i % 12) * 5:02d}:00Z", o, o * 1.002, min(o, c) * 0.99, c))
            price[s] = c
    daily = []
    for s in ("ETH", "TSLA"):
        px = 100.0
        for d in range(1, 28):
            daily.append((s, f"2026-01-{d:02d}", px, px, px, px))
        daily += [(s, "2026-01-29", 100, 100, 100, 100), (s, "2026-01-30", 100, 100, 100, 100), (s, "2026-01-31", 100, 100, 85, 85), (s, "2026-02-01", 85, 85, 85, 80)]
    daily.sort()
    _write_candles(tmp_path, rows, daily)
    book = mk([("ETH", 2.0, 100_000.0)], hedge={"ETH": 200_000.0})
    ctx = Context(data_dir=tmp_path)
    res = run_scenario(book, SCENARIOS["oct_10_2025"], H, ctx)
    assert res.status == "ok" and {m["name"] for m in res.moves} == {"ETH", "BTC"}
    eth = next(m for m in res.moves if m["name"] == "ETH")
    assert eth["open"] == 4000.0 and eth["low"] < eth["open"] and eth["window_candles"] == 24
    j = run_scenario(book, SCENARIOS["jan_31_2026"], H, ctx)
    m = next(x for x in j.moves if x["name"] == "ETH")
    assert j.extra["stress_found"] and m["worst_1d"] == pytest.approx(-0.15) and m["on_2026-01-31"] == pytest.approx(-0.15)
    assert any("TODO" in n for n in j.notes)


def test_missing_data_is_a_failure_not_a_default(tmp_path):
    book = mk([("ETH", 2.0, 100_000.0)])
    for name in ("oct_10_2025", "jan_31_2026"):
        res = run_scenario(book, SCENARIOS[name], H, Context(data_dir=tmp_path))
        assert res.status == "data_missing" and res.worst_loss == 0.0 and res.cases == [] and "data_missing" in res.flags


def test_no_holder_liquidation_path():
    book = load_fixture(FIX)
    before = repr(book)
    results = run_all(book, H, Context(vol_paths=2))
    assert repr(book) == before                                   # the book (holder balances included) is never touched
    assert set(results) == set(SCENARIOS)
    text = json.dumps([r.cases for r in results.values()])
    assert "liquidat" not in text


def test_flags_when_contract_budget_looser_than_scenarios():
    book = load_fixture(FIX)
    res = run_all(book, H, Context(vol_paths=2))
    worst = max(r.worst_loss for r in res.values())
    assert budget_flags(res, worst * 1.19) == {}
    flagged = budget_flags(res, worst / 1.21)
    assert flagged and all(v == ["contract_budget_too_loose"] for v in flagged.values())
