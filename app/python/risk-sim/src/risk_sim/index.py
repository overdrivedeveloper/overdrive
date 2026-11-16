"""Exact gear values (todo 03 twin, float64): NF x (P_t/P_0)^p x unit. Never a Taylor expansion."""

from __future__ import annotations

POWERS = {0: 1.5, 1: 2.0, 2: 3.0, 3: 0.5, 4: -1.0}   # Gear enum: Cruise Sport Race Eco Reverse
NAMES = {1.5: "Cruise", 2.0: "Sport", 3.0: "Race", 0.5: "Eco", -1.0: "Reverse"}
MIN_R, MAX_R = 0.02, 50.0                              # on-chain ratio domain (-98% .. +4,900%)


def gear_value(p: float, price_ratio: float, nf: float, unit: float) -> float:
    """price_ratio is P_t/P_0 (A/B ratio ratio for pair gears). nf and unit are plain numbers (WAD / 1e18)."""
    if price_ratio <= 0:
        raise ValueError("price ratio must be positive")
    return nf * price_ratio**p * unit


def in_domain(price_ratio: float) -> bool:
    return MIN_R <= price_ratio <= MAX_R
