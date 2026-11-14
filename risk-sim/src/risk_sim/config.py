"""Settings from the environment, spec cap groups, and the shared floors file."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
FLOORS_FILE = DATA_DIR / "floors.json"      # the shared floor config; vol-engine's floors are checked against it in a test

CRYPTO = ("ETH", "BTC")
STOCKS = ("TSLA", "NVDA", "SPY", "QQQ", "AAPL", "MSFT", "META", "AMZN", "COIN", "MSTR", "PLTR", "AMD", "HOOD")
GEAR_POWERS = (1.5, 2.0, 0.5, -1.0)          # Cruise, Sport, Eco, Reverse (Race 3.0 only where the group allows it)

# Spec section 4 starting maxima per gear. "gears" are the powers a name may list in that group.
SPEC_GROUPS: dict[str, dict] = {
    "crypto": {"members": ["ETH", "BTC"], "cap_usd": 5_000_000.0, "spread_bps": 40, "powers": [1.5, 2.0, 0.5, -1.0]},
    "mega": {"members": ["TSLA", "NVDA", "AAPL", "MSFT", "META", "AMZN", "AMD"], "cap_usd": 1_000_000.0, "spread_bps": 60,
             "powers": [1.5, 2.0, 0.5, -1.0]},
    "index": {"members": ["SPY", "QQQ"], "cap_usd": 2_000_000.0, "spread_bps": 50, "powers": [1.5, 2.0, 3.0, 0.5, -1.0]},
    "retail": {"members": ["HOOD", "COIN", "MSTR", "PLTR"], "cap_usd": 300_000.0, "spread_bps": 100, "powers": [1.5, 2.0, 0.5, -1.0]},
    "pairs": {"members": ["NVDA/AMD", "QQQ/SPY", "COIN/MSTR"], "cap_usd": 500_000.0, "spread_bps": 80, "powers": [1.5, 2.0, 0.5, -1.0]},
}
RACE_MAX_VOL = 0.40                           # Race on SPY and QQQ only while vol <= 40%

# Scenario assumptions that are NOT in the spec; each is printed in the report.
OCT10_OUTAGE_S = 1800                         # length of the venue outage window (assumed 30 min around the low)
OCT10_SPREAD_MULT = 2.0
JAN31_WINDOW_DAYS = 3
JAN31_MIN_STRESS = 0.03                       # below this 1-day move across every name the day is "no stress"
JAN31_FALLBACK_YEARS = 2
SINGLE_STOCK_GAP = 0.187
WEEKEND_GAP = 0.15
OUTAGE_MOVE = 0.05
OUTAGE_S = 1800
SPLIT_RATIOS = (2.0, 3.0, 10.0, 0.1)
SIGMA_STEP_LIMIT = 0.25
SIGMA_POST_INTERVAL_S = 6 * 3600
VOL_SPIKE_PATHS = 20
ONCHAIN_SHOCK_BPS_DEFAULT = 1500              # TODO(05a): replace with IODGovernor's stress shock s once the contract lands
STALE_PRICE_S = 15 * 60

DEFAULT_FLOORS = {"crypto": 0.40, "index_etf": 0.15, "mega": 0.30, "retail": 0.45, "pair": 0.30}


def floors() -> dict:
    try:
        return json.loads(FLOORS_FILE.read_text())
    except FileNotFoundError:
        return dict(DEFAULT_FLOORS)


def floor_for(key: str) -> float:
    f, k = floors(), key.upper()
    if "/" in k:
        return f["pair"]
    if k in CRYPTO:
        return f["crypto"]
    if k in ("SPY", "QQQ"):
        return f["index_etf"]
    if k in ("HOOD", "COIN", "MSTR", "PLTR"):
        return f["retail"]
    return f["mega"]


def is_crypto(name: str) -> bool:
    return name.upper() in CRYPTO


@dataclass(frozen=True)
class Settings:
    database_url: str = ""
    write_database_url: str = ""
    max_loss_bps: int = 1500
    hedge_lag_s: int = 1800
    hedge_band_bps: int = 50
    hedge_hard_band_bps: int = 200
    hedge_cycle_s: int = 60
    hedge_cooldown_s: int = 120
    hedge_min_trade_usd: float = 25.0
    hedge_slippage_bps: float = 10.0
    hedge_fee_bps: float = 2.0
    out_dir: str = "out"
    max_book_age_s: int = 900
    telegram_outbox: str = ""
    seed: int = 1331057260
    onchain_shock_bps: int = ONCHAIN_SHOCK_BPS_DEFAULT
    coverage_largest: float = 1.0
    coverage_total: float = 0.25
    extras: dict = field(default_factory=dict)

    @staticmethod
    def from_env(env: dict | None = None) -> "Settings":
        e = os.environ if env is None else env

        def num(key: str, default, cast=int):
            v = e.get(key, "")
            if v == "":
                return default
            try:
                return cast(v)
            except ValueError as exc:
                raise ValueError(f"{key}: not a number ({v!r})") from exc

        s = Settings(
            database_url=e.get("DATABASE_URL", ""),
            write_database_url=e.get("RISK_WRITE_DATABASE_URL", ""),
            max_loss_bps=num("RISK_MAX_LOSS_BPS", 1500),
            hedge_lag_s=num("RISK_HEDGE_LAG_SECONDS", num("HEDGER_INTERVAL_SECONDS", 1800)),
            hedge_band_bps=num("HEDGER_BAND_BPS", 50),
            hedge_hard_band_bps=num("HEDGER_HARD_BAND_BPS", 200),
            hedge_cycle_s=num("HEDGER_CYCLE_SECONDS", 60),
            hedge_cooldown_s=num("HEDGER_COOLDOWN_SECONDS", 120),
            hedge_slippage_bps=num("RISK_HEDGE_SLIPPAGE_BPS", 10.0, float),
            out_dir=e.get("RISK_OUT_DIR", "out"),
            max_book_age_s=num("RISK_MAX_BOOK_AGE_SECONDS", 900),
            telegram_outbox=e.get("TELEGRAM_OUTBOX", ""),
            seed=num("RISK_SEED", 1331057260),
            onchain_shock_bps=num("RISK_ONCHAIN_SHOCK_BPS", ONCHAIN_SHOCK_BPS_DEFAULT),
        )
        if not 1 <= s.max_loss_bps <= 10_000:
            raise ValueError("RISK_MAX_LOSS_BPS must be in 1..10000")
        if s.hedge_lag_s <= 0 or s.max_book_age_s <= 0:
            raise ValueError("lag and max book age must be positive")
        return s
