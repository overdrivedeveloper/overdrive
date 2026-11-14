"""sigma-hat: two-scale EWMA of 5-minute returns (plus an overnight-gap term for equities), and the pair estimator."""

from __future__ import annotations

import math

from .bars import Bars
from .config import HALF_LIFE_FAST_DAYS, HALF_LIFE_SLOW_DAYS
from .ewma import decay_for_half_life, ewma_variance


def sigma_scale(bars: Bars, half_life_days: float) -> float:
    """Annualised sigma at one half-life; 0.0 when there is under one day of bars (the floor then decides)."""
    if len(bars.returns) < bars.bars_per_day:
        return 0.0
    bar_var = ewma_variance(bars.returns, decay_for_half_life(half_life_days * bars.bars_per_day))
    gap_var = ewma_variance(bars.gaps, decay_for_half_life(half_life_days)) if bars.gaps else 0.0
    daily_var = bars.bars_per_day * bar_var + gap_var   # the overnight gap enters as its own variance term
    return math.sqrt(bars.days_per_year * daily_var)


def sigma_two_scale(bars: Bars, half_life_fast_days: float = HALF_LIFE_FAST_DAYS,
                    half_life_slow_days: float = HALF_LIFE_SLOW_DAYS) -> float:
    """max(sigma_fast, sigma_slow), annualised (252 days for equities, 365 for crypto). The markup is applied elsewhere."""
    return max(sigma_scale(bars, half_life_fast_days), sigma_scale(bars, half_life_slow_days))


def ratio_bars(bars_a: Bars, bars_b: Bars) -> Bars:
    """Bars of the log ratio A over B: the difference of the two legs' returns on the buckets (and days) both have."""
    out = Bars(bars_a.kind)
    b_ret = dict(zip(bars_b.ret_keys, bars_b.returns))
    for k, r in zip(bars_a.ret_keys, bars_a.returns):
        if k in b_ret:
            out.ret_keys.append(k)
            out.returns.append(r - b_ret[k])
    b_gap = dict(zip(bars_b.gap_keys, bars_b.gaps))
    for k, g in zip(bars_a.gap_keys, bars_a.gaps):
        if k in b_gap:
            out.gap_keys.append(k)
            out.gaps.append(g - b_gap[k])
    return out


def sigma_pair(bars_a: Bars, bars_b: Bars) -> float:
    """Sigma of the log ratio of two prices, same two scales as a single name."""
    return sigma_two_scale(ratio_bars(bars_a, bars_b))
