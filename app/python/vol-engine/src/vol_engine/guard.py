"""Step and bounds guard: a Python port of ODVolOracle.post's rules, so the engine never plans a value the contract rejects."""

from __future__ import annotations

from dataclasses import dataclass

from .config import (
    BPS,
    HARD_MAX_CEILING_BPS,
    HARD_MIN_FLOOR_BPS,
    MAX_BUY_BLOCK_S,
    MAX_STEP_BPS,
    MAX_VALIDITY_S,
    MIN_POST_INTERVAL_S,
    MIN_VALIDITY_S,
)


@dataclass(frozen=True)
class ChainState:
    """What the oracle holds for one market (read(market) plus lastNonce); `posted_at` 0 means never posted."""
    sigma_bps: int = 0
    posted_at: int = 0
    valid_until: int = 0
    nonce: int = 0
    buy_block_from: int = 0
    buy_block_to: int = 0


def bounds_ceiling(ceiling_bps: int, race: bool = False) -> int:
    from .config import RACE_CEILING_BPS
    return min(ceiling_bps, RACE_CEILING_BPS) if race else ceiling_bps


def step_bounds(prior_bps: int, floor_bps: int, ceiling_bps: int) -> tuple[int, int]:
    """Allowed [lo, hi] for the next sigma. The reference is the prior value clamped into the bounds, as in the contract
    (diff x 10000 <= ref x 2500, i.e. diff <= floor(ref / 4))."""
    ref = min(max(prior_bps, floor_bps), ceiling_bps)
    allowed = ref * MAX_STEP_BPS // BPS
    return max(ref - allowed, floor_bps), min(ref + allowed, ceiling_bps)


def clamp_step(target_bps: int, prior_bps: int | None, floor_bps: int, ceiling_bps: int) -> tuple[int, list[str]]:
    """Returns (value, flags). Bounds first (`clamped`), then the 25% step against a prior post (`ramped`); with no prior
    post only the bounds apply (the first post is exempt)."""
    flags: list[str] = []
    value = min(max(target_bps, floor_bps), ceiling_bps)
    if value != target_bps:
        flags.append("clamped")
    if prior_bps:
        lo, hi = step_bounds(prior_bps, floor_bps, ceiling_bps)
        stepped = min(max(value, lo), hi)
        if stepped != value:
            flags.append("ramped")
        value = stepped
    return value, flags


def contract_rejects(*, sigma_bps: int, buy_from: int, buy_to: int, valid_until: int, nonce: int, now: int,
                     state: ChainState, floor_bps: int, ceiling_bps: int,
                     min_interval_s: int = MIN_POST_INTERVAL_S) -> str | None:
    """The reason ODVolOracle.post would revert for these values, or None. Mirrors the contract's check order."""
    if valid_until < now + MIN_VALIDITY_S or valid_until > now + MAX_VALIDITY_S:
        return "Expired"
    if nonce <= state.nonce:
        return "NonceUsed"
    if state.posted_at != 0 and now < state.posted_at + min_interval_s:
        return "TooSoon"
    if sigma_bps < floor_bps or sigma_bps > ceiling_bps:
        return "OutOfBounds"
    if state.posted_at != 0:
        ref = min(max(state.sigma_bps, floor_bps), ceiling_bps)
        diff = abs(sigma_bps - ref)
        if diff * BPS > ref * MAX_STEP_BPS:
            return "StepTooLarge"
    if buy_from != 0 or buy_to != 0:
        if buy_from < now or buy_to < buy_from or buy_to - buy_from > MAX_BUY_BLOCK_S:
            return "BadBuyBlockWindow"
    return None


__all__ = ["ChainState", "clamp_step", "step_bounds", "contract_rejects", "bounds_ceiling", "HARD_MIN_FLOOR_BPS",
           "HARD_MAX_CEILING_BPS"]
