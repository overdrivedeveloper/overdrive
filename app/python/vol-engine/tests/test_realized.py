"""R2: sigma_two_scale recovers a known sigma and reacts to a shock."""

import numpy as np

from vol_engine.bars import build_crypto_bars, build_equity_bars
from vol_engine.realized import sigma_two_scale

from helpers import crypto_ticks, equity_ticks, weekdays
from datetime import date

T0 = 1_760_000_000.0
N60 = 60 * 288


def test_recovers_true_sigma():
    for seed, true in [(3, 0.30), (4, 0.60), (5, 1.00)]:
        bars = build_crypto_bars(crypto_ticks(T0, N60, true, seed=seed))
        assert abs(sigma_two_scale(bars) / true - 1) < 0.10, (seed, true)
    # equities: 5-minute bars within 252 regular days plus a gap term
    days = weekdays(date(2026, 8, 3), 60)
    true = np.sqrt(252 * (78 * 0.0006**2 + 0.004**2))
    bars = build_equity_bars(equity_ticks(days, seed=7))
    assert abs(sigma_two_scale(bars) / true - 1) < 0.10


def test_shock_raises_sigma():
    base = build_crypto_bars(crypto_ticks(T0, N60, 0.5, seed=11))
    shocked = build_crypto_bars(crypto_ticks(T0, N60, 0.5, seed=11, shock_at=N60 - 40, shock=0.06))
    assert sigma_two_scale(shocked) > sigma_two_scale(base) * 1.05


def test_short_history_gives_zero_so_the_floor_decides():
    bars = build_crypto_bars(crypto_ticks(T0, 100, 0.5))
    assert sigma_two_scale(bars) == 0.0
