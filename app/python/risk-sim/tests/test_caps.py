import random

import pytest

from helpers import mk
from risk_sim import config as C
from risk_sim.book import Book
from risk_sim.caps import group_of, recommend_caps, universe, _loss
from risk_sim.hedge_model import HedgeModel
from risk_sim.scenarios import Context

CTX = Context(vol_paths=2)
QUICK = ["single_stock_minus_18_7", "weekend_gap_both_ways", "venue_outage_30m"]
H = HedgeModel()


def tmpl(equity):
    return Book(gears=(), equity_usd=equity, sigma_bps={})


def small(equity):
    return mk([("TSLA", 2.0, 1.0), ("ETH", 2.0, 1.0), ("SPY", 2.0, 1.0)], equity=equity, sigma={"TSLA": 6000.0, "ETH": 6000.0, "SPY": 2500.0})


def test_scaling_meets_max_loss_and_is_monotone():
    prev = None
    for eq in (50_000.0, 1_000_000.0, 80_000_000.0):
        b = small(eq)
        plan = recommend_caps(b, None, 1500, hedge=H, ctx=CTX)
        assert plan.worst_loss_usd <= 0.15 * eq * (1 + 1e-9)
        # independent check: re-run the plan's caps through the scenarios
        scale = {g: f for g, f in plan.factors.items()}
        assert _loss(b, universe(b, None, scale), H, CTX) <= 0.15 * eq * (1 + 1e-6)
        caps = {c["gear"]: c["cap_usd"] for c in plan.caps}
        if prev:
            assert all(caps[k] >= prev[k] - 1e-6 for k in caps)
        prev = caps


def test_zero_equity_zero_caps():
    for eq in (0.0, -5.0):
        plan = recommend_caps(small(eq), None, 1500, hedge=H, ctx=CTX)
        assert plan.caps and all(c["cap_usd"] == 0 for c in plan.caps)


def test_never_above_spec_maximum():
    plan = recommend_caps(small(1e12), None, 1500, hedge=H, ctx=CTX)
    assert all(c["cap_usd"] <= c["spec_max_usd"] for c in plan.caps)
    assert max(c["factor"] for c in plan.caps) <= 1.0
    full = recommend_caps(tmpl(1e12), None, 1500, hedge=H, ctx=CTX)
    assert {c["group"] for c in full.caps} == set(C.SPEC_GROUPS) and all(c["cap_usd"] <= c["spec_max_usd"] for c in full.caps)


def test_property_scaling_monotone():
    """200 random books: scaling every position by f in (0, 1] never raises the worst loss, and the recommended plan stays within the limit."""
    rng = random.Random(18)
    names = ["TSLA", "NVDA", "SPY", "ETH", "COIN"]
    for _ in range(200):
        gears = [(rng.choice(names), rng.choice([1.5, 2.0, 0.5, -1.0]), rng.uniform(1e3, 5e5)) for _ in range(rng.randint(1, 6))]
        b = mk(gears)
        f = rng.uniform(0.05, 1.0)
        big = _loss(b, list(b.gears), H, Context(vol_paths=1), QUICK)
        small_g = [g.__class__(g.id, g.key, g.power, g.supply_tokens * f, 0.0, 1.0, g.cap_usd) for g in b.gears]
        assert _loss(b, small_g, H, Context(vol_paths=1), QUICK) <= big * (1 + 1e-9) + 1e-6
    plan = recommend_caps(small(300_000.0), None, 1500, hedge=H, ctx=CTX)
    assert plan.worst_loss_usd <= 45_000.0 * (1 + 1e-9)
    assert group_of("NVDA/AMD") == "pairs"
