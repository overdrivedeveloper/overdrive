"""Toll model (todo 03 twin): annual toll = p(p-1)/2 sigma^2 + usage, clamped to +-400%/yr."""

from __future__ import annotations

YEAR_S = 365 * 86_400
MAX_TOLL = 4.0


def toll_per_year(power: float, sigma: float, usage: float = 0.0) -> float:
    t = power * (power - 1.0) / 2.0 * sigma * sigma + min(usage, 2 * MAX_TOLL)
    return max(-MAX_TOLL, min(MAX_TOLL, t))


def usage_term(open_value: float, cap: float, usage_max: float) -> float:
    if open_value <= 0 or cap <= 0:
        return 0.0
    u = min(1.0, open_value / cap)
    return usage_max * u * u


def toll_income(value_usd: float, power: float, sigma: float, dt_s: float, usage: float = 0.0) -> float:
    return value_usd * toll_per_year(power, sigma, usage) * dt_s / YEAR_S
