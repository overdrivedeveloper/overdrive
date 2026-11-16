"""The floor and markup, and the earnings and weekend variance bumps. Published verbatim in FORMULA.md."""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from .config import (
    EARNINGS_MOVE_DEFAULT,
    EARNINGS_MOVES_USED,
    EVENT_RAMP_S,
    MARKUP,
    MIN_EARNINGS_MOVES,
    MIN_WEEKEND_SAMPLES,
    WEEKEND_GAP_DEFAULT,
    WEEKEND_PERCENTILE,
    YEAR_SECONDS,
    floor_for,
)


def sigma_hat(sigma_rv: float, key: str) -> float:
    """max(sigma_RV x 1.15, floor[key]). A key with no usable history (sigma_RV 0) lands on the floor."""
    return max(sigma_rv * MARKUP, floor_for(key))


def event_ratio(sigma: float, move: float, tau_s: float) -> float:
    """R = 1 + E^2 / (tau sigma^2), tau in years: sigma_eff^2 = sigma^2 R once the event is fully on."""
    return 1.0 + move * move / ((tau_s / YEAR_SECONDS) * sigma * sigma)


def add_event_variance(sigma: float, move: float, tau_s: float, weight: float = 1.0) -> float:
    """sigma_eff^2 = sigma^2 x R^w with the weight clamped to [0, 1]."""
    w = max(0.0, min(1.0, weight))
    return sigma * event_ratio(sigma, move, tau_s) ** (w / 2.0)


def earnings_weight(report_ts: float, now_s: float, ramp_s: float = EVENT_RAMP_S) -> float:
    """0 until `ramp_s` before the report, rising linearly to 1 at the report (and 1 after it, while the block lasts)."""
    if now_s >= report_ts:
        return 1.0
    return max(0.0, 1.0 - (report_ts - now_s) / ramp_s)


def weekend_weight(elapsed_s: float, ramp_s: float = EVENT_RAMP_S) -> float:
    """0 at the start of the closed run, rising linearly to 1 after `ramp_s`; the bump ends with the run."""
    return max(0.0, min(1.0, elapsed_s / ramp_s))


def earnings_move(key: str, past_moves: Sequence[float]) -> tuple[float, list[str]]:
    """E = median |1-day move| over the last 8 reports. Fewer than 4 reports: conservative default, flagged."""
    recent = [abs(m) for m in past_moves][-EARNINGS_MOVES_USED:]
    if len(recent) < MIN_EARNINGS_MOVES:
        return EARNINGS_MOVE_DEFAULT.get(key.upper(), EARNINGS_MOVE_DEFAULT["default"]), ["earnings_move_default"]
    return float(np.median(recent)), []


def weekend_move(key: str, gaps: Sequence[float]) -> tuple[float, list[str]]:
    """G = 90th percentile of |Friday close to Monday open|; fewer than 26 weeks: conservative default, flagged."""
    samples = [abs(g) for g in gaps]
    if len(samples) < MIN_WEEKEND_SAMPLES:
        return WEEKEND_GAP_DEFAULT.get(key.upper(), WEEKEND_GAP_DEFAULT["default"]), ["weekend_move_default"]
    return float(np.percentile(samples, WEEKEND_PERCENTILE)), []


def to_bps(sigma: float) -> int:
    return int(math.floor(sigma * 10_000 + 0.5))
