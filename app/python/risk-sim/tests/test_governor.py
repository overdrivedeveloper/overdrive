import dataclasses

import pytest

from helpers import HEDGER_BOOK, mk
from risk_sim.book import Book, GearPos
from risk_sim.governor import netting, onchain_stress, simulate
from risk_sim.hedge_model import HedgeModel
from risk_sim.paths import Step, gap

OFF = HedgeModel(enabled=False)


def test_netting_matches_hedger_vector():
    book = mk(HEDGER_BOOK)
    delta, gamma = netting(book.gears)["X"]
    assert delta == 200_000 and gamma == 275_000


def test_small_move_matches_gamma_formula():
    book = mk(HEDGER_BOOK)
    for r in (0.01, -0.01):
        res = simulate(book, gap({"X": r}), OFF)
        assert res.pnl < 0
        assert abs(res.pnl) == pytest.approx(0.5 * 275_000 * r * r, rel=0.01)


def test_backer_minted_supply_excluded():
    g = GearPos("a", "X", 2.0, supply_tokens=1000.0, backer_debt_tokens=400.0, value_per_token=1.0)
    assert g.governor_value_usd == 600.0
    full = Book((GearPos("a", "X", 2.0, 1000.0, 0.0, 1.0),), 1e5, hedge_position_usd={})
    part = Book((g,), 1e5, hedge_position_usd={})
    up = gap({"X": 0.1})
    assert simulate(part, up, OFF).gear_pnl == pytest.approx(0.6 * simulate(full, up, OFF).gear_pnl)


def test_pnl_identity():
    """Two steps by hand: hedge P&L - change in gear value + toll income - costs = change in equity, with the exact numbers worked out here."""
    g = GearPos("a", "X", 2.0, 1000.0, 0.0, 1.0, toll_usd_per_year=36_500.0)       # toll 36,500 USD/yr on 1,000 USD of value: 100 per day
    book = Book((g,), 10_000.0, hedge_position_usd={"X": 2000.0}, sigma_bps={"X": 6000.0})
    path = [Step(86_400.0, {"X": 0.10}, venue_up=False), Step(86_400.0, {"X": -0.05}, venue_up=False)]
    res = simulate(book, path, OFF)
    # hand: day 1 end ratio 1.10; hedge 2000*0.10=200; gear 1000*(1.21-1)=210 -> -210; day 2 ratio 1.045:
    # hedge 2000*(1.045-1.10)=-110; gear value 1000*1.045^2=1092.025 vs 1210 -> +117.975
    hedge_pnl, gear_pnl = 200.0 - 110.0, -210.0 + 117.975
    assert res.hedge_pnl == pytest.approx(hedge_pnl, abs=1e-6) and res.gear_pnl == pytest.approx(gear_pnl, abs=1e-6)
    assert res.income > 0 and res.costs == 0
    assert res.pnl == pytest.approx(hedge_pnl + gear_pnl + res.income)
    assert res.equity_end - res.equity_start == pytest.approx(res.pnl)


FIXTURE_BOOKS = [
    # (book, shock_bps, expected loss by hand) markets add with no diversification credit
    ([("A", 2.0, 100_000.0)], {"A": 200_000.0}, 1000),
    ([("A", 2.0, 100_000.0), ("B", -1.0, 50_000.0)], {"A": 100_000.0, "B": -50_000.0}, 1000),
]


def _hand(gears, hedge, shock_bps, stale=False):
    s, tot = shock_bps / 1e4, 0.0
    for m in sorted({k for k, _, _ in gears}):
        h = 0.0 if stale else hedge.get(m, 0.0)
        tot += max([0.0] + [-(h * x - sum(v * ((1 + x) ** p - 1) for k, p, v in gears if k == m)) for x in (-s, -s / 2, s / 2, s)])
    return tot


def test_matches_onchain_stress_on_fixture_books():
    for gears, hedge, bps in FIXTURE_BOOKS:
        b = mk(gears, hedge=hedge)
        loss, budget, _ = onchain_stress(b, bps)
        assert loss == pytest.approx(_hand(gears, hedge, bps), rel=1e-3)
        assert budget == pytest.approx(400_000 * 0.15)
    # stale hedge counts zero: the loss is the unhedged one and is never smaller
    gears, hedge, bps = FIXTURE_BOOKS[0]
    stale = mk(gears, hedge=hedge, hedge_stale=True)
    assert onchain_stress(stale, bps)[0] == pytest.approx(_hand(gears, hedge, bps, stale=True), rel=1e-3)
    assert onchain_stress(stale, bps)[0] >= onchain_stress(mk(gears, hedge=hedge), bps)[0]
