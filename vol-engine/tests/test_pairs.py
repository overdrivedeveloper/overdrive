"""R10: pair sigma from the log ratio, and a pair posts only when both legs are fresh."""

import numpy as np
from datetime import datetime, timezone

from vol_engine.bars import build_crypto_bars
from vol_engine.config import Settings
from vol_engine.engine import StoreOracle, plan_pass
from vol_engine.history import History
from vol_engine.realized import sigma_pair, sigma_two_scale
from vol_engine.store import MemoryStore

from helpers import ANVIL_KEY, ORACLE, crypto_ticks

T0 = 1_760_000_000.0
N = 60 * 288


def correlated(rho, va=0.6, vb=0.4, seed=21):
    rng = np.random.default_rng(seed)
    za = rng.normal(0, 1, N)
    zb = rho * za + np.sqrt(1 - rho**2) * rng.normal(0, 1, N)
    return crypto_ticks(T0, N, va, normals=za), crypto_ticks(T0, N, vb, normals=zb), va, vb


def test_pair_sigma_matches_formula():
    for rho in (0.0, 0.5, 0.9):
        ta, tb, va, vb = correlated(rho)
        a, b = build_crypto_bars(ta), build_crypto_bars(tb)
        sa, sb = sigma_two_scale(a), sigma_two_scale(b)
        # rho as the engine's own estimator sees it: from the full-sample correlation of the 5-minute returns
        r = float(np.corrcoef(a.returns, b.returns)[0, 1])
        expected = (sa**2 + sb**2 - 2 * r * sa * sb) ** 0.5
        got = sigma_pair(a, b)
        assert abs(got / expected - 1) < 0.03, (rho, got, expected)
        true = (va**2 + vb**2 - 2 * rho * va * vb) ** 0.5
        assert abs(got / true - 1) < 0.15


def settings(**kw):
    return Settings(signer_key=ANVIL_KEY, oracle_address=ORACLE, chain_id=31337, keys=("ETH/BTC",), **kw)


def test_pair_needs_both_legs_fresh():
    ta, tb, *_ = correlated(0.5)
    now = ta[-1].ts + 60
    st = MemoryStore()
    st.tick_rows = {"ETH": ta, "BTC": tb}
    out = plan_pass(now, settings(), st, History(), force=True)
    assert len(out) == 1 and out[0].key == "ETH/BTC" and out[0].sigma_bps >= 3000
    assert len(st.alerts) == 0
    # one leg goes stale: nothing is planned for the pair and an alert says which leg
    st2 = MemoryStore()
    st2.tick_rows = {"ETH": ta, "BTC": tb[: N - 20]}
    assert plan_pass(now, settings(), st2, History(), force=True) == []
    assert st2.alerts[0]["kind"] == "stale_prices" and st2.alerts[0]["detail"]["leg"] == "BTC"
    # one leg missing entirely
    st3 = MemoryStore()
    st3.tick_rows = {"ETH": ta}
    assert plan_pass(now, settings(), st3, History(), force=True) == []
    assert st3.alerts[0]["kind"] == "no_prices"
