"""R13: FORMULA.md names every constant and each equals the code's."""

import re
from pathlib import Path

from vol_engine import config as c

DOC = Path(__file__).resolve().parents[1] / "FORMULA.md"

EXPECTED = {
    "markup": c.MARKUP, "half_life_fast_days": c.HALF_LIFE_FAST_DAYS, "half_life_slow_days": c.HALF_LIFE_SLOW_DAYS,
    "equity_days_per_year": c.EQUITY_DAYS_PER_YEAR, "crypto_days_per_year": c.CRYPTO_DAYS_PER_YEAR, "bar_seconds": c.BAR_SECONDS,
    "max_step_bps": c.MAX_STEP_BPS, "min_post_interval_s": c.MIN_POST_INTERVAL_S, "min_validity_s": c.MIN_VALIDITY_S,
    "max_validity_s": c.MAX_VALIDITY_S, "default_validity_s": c.DEFAULT_VALIDITY_S, "max_buy_block_s": c.MAX_BUY_BLOCK_S,
    "min_relative_change": c.MIN_RELATIVE_CHANGE, "renew_fraction": c.RENEW_FRACTION, "max_tick_age_s": c.MAX_TICK_AGE_S,
    "pending_ttl_s": c.PENDING_TTL_S, "earnings_lookahead_days": c.EARNINGS_LOOKAHEAD_DAYS,
    "earnings_moves_used": c.EARNINGS_MOVES_USED, "min_earnings_moves": c.MIN_EARNINGS_MOVES,
    "min_weekend_samples": c.MIN_WEEKEND_SAMPLES, "weekend_percentile": c.WEEKEND_PERCENTILE,
    "block_before_s": c.BLOCK_BEFORE_S, "block_after_s": c.BLOCK_AFTER_S, "unconfirmed_block_s": c.UNCONFIRMED_BLOCK_S,
    "event_tau_earnings_s": c.EVENT_TAU_EARNINGS_S, "event_ramp_s": c.EVENT_RAMP_S, "race_ceiling_bps": c.RACE_CEILING_BPS,
    "floor_crypto": c.FLOOR_CRYPTO, "floor_index_etf": c.FLOOR_INDEX_ETF, "floor_mega": c.FLOOR_MEGA,
    "floor_retail": c.FLOOR_RETAIL, "floor_pair": c.FLOOR_PAIR,
    "earnings_move_default": c.EARNINGS_MOVE_DEFAULT["default"], "earnings_move_default_TSLA": c.EARNINGS_MOVE_DEFAULT["TSLA"],
    "earnings_move_default_NVDA": c.EARNINGS_MOVE_DEFAULT["NVDA"], "weekend_gap_default": c.WEEKEND_GAP_DEFAULT["default"],
    "weekend_gap_default_SPY": c.WEEKEND_GAP_DEFAULT["SPY"], "weekend_gap_default_QQQ": c.WEEKEND_GAP_DEFAULT["QQQ"],
}


def parse() -> dict[str, float]:
    rows = re.findall(r"^\|\s*([a-zA-Z0-9_]+)\s*\|\s*([0-9.]+)\s*\|\s*$", DOC.read_text(), flags=re.M)
    return {k: float(v) for k, v in rows}


def test_doc_matches_config():
    doc = parse()
    assert set(doc) == set(EXPECTED), set(doc) ^ set(EXPECTED)
    for name, value in EXPECTED.items():
        assert doc[name] == float(value), name
    # the oracle's own constants the page quotes
    assert c.MAX_STEP_BPS == 2500 and c.MIN_POST_INTERVAL_S == 30 and c.MAX_VALIDITY_S == 7200 and c.MIN_VALIDITY_S == 300


def test_floors_sit_at_or_above_the_oracle_hard_floor_and_spy_is_d22():
    for key in c.default_keys():
        assert round(c.floor_for(key) * c.BPS) >= c.HARD_MIN_FLOOR_BPS
    assert c.floor_for("SPY") == c.floor_for("QQQ") == 0.15 < 0.18


def test_every_listed_name_has_a_floor_and_a_market():
    from vol_engine.markets import resolve
    assert len({resolve(k).hex for k in c.default_keys()}) == len(c.default_keys())
