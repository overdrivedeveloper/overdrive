import math

import pytest

from vol_engine.config import FLOOR_CRYPTO, FLOOR_INDEX_ETF, FLOOR_MEGA, FLOOR_PAIR, FLOOR_RETAIL, MARKUP, floor_for
from vol_engine.surface import add_event_variance, event_ratio, sigma_hat, to_bps


def test_floor_and_markup():
    assert MARKUP == 1.15
    assert sigma_hat(0.20, "NVDA") == pytest.approx(0.30)          # 0.23 < the 30% floor
    assert sigma_hat(0.50, "NVDA") == pytest.approx(0.575)         # 0.5 x 1.15, no bump
    assert sigma_hat(0.0, "SPY") == FLOOR_INDEX_ETF == 0.15        # D22: SPY and QQQ floor 15%
    assert sigma_hat(0.10, "QQQ") == pytest.approx(0.15)
    assert sigma_hat(0.10, "COIN") == FLOOR_RETAIL
    assert sigma_hat(0.10, "ETH") == FLOOR_CRYPTO and sigma_hat(0.5, "BTC") == pytest.approx(0.575)
    assert sigma_hat(0.10, "NVDA/AMD") == FLOOR_PAIR                # a pair has its own floor
    assert sigma_hat(0.40, "NVDA/AMD") == pytest.approx(0.46)
    assert floor_for("tsla") == FLOOR_MEGA


def test_event_variance_matches_formula_and_never_lowers():
    sigma, e, tau = 0.5, 0.07, 86_400
    full = add_event_variance(sigma, e, tau, 1.0)
    assert full**2 == pytest.approx(sigma**2 + e**2 / (tau / (365 * 86_400)))
    assert event_ratio(sigma, e, tau) > 1
    assert add_event_variance(sigma, e, tau, 0.0) == sigma
    ws = [add_event_variance(sigma, e, tau, w / 10) for w in range(11)]
    assert ws == sorted(ws) and all(x >= sigma for x in ws)
    assert to_bps(0.5749999) == 5750 and to_bps(0.30) == 3000
    assert not math.isnan(full)
