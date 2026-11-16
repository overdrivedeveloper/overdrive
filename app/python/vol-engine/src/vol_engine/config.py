"""Static parameters and environment settings. Every number the published formula (FORMULA.md) names lives here.

Secrets come from the process environment (a raw key for development, or a keystore plus password file) and are excluded
from every repr. An unknown VOL_* variable refuses to start.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from .keystore import KeyConfigError, load_key

BPS = 10_000
BAR_SECONDS = 300
EQUITY_BARS_PER_DAY = 78      # 6.5 regular hours of 5-minute bars
CRYPTO_BARS_PER_DAY = 288     # 24 hours of 5-minute bars
EQUITY_DAYS_PER_YEAR = 252
CRYPTO_DAYS_PER_YEAR = 365
YEAR_SECONDS = 365 * 86_400

HALF_LIFE_FAST_DAYS = 1.0
HALF_LIFE_SLOW_DAYS = 5.0
MARKUP = 1.15

# Event bumps (equities only). sigma_eff^2 = sigma^2 * R^w, R = 1 + E^2 / (tau sigma^2).
EVENT_TAU_EARNINGS_S = 86_400          # the toll is a daily charge: an earnings move is spread over one day
EVENT_RAMP_S = 6 * 3_600               # w climbs linearly from 0 to 1 over this long before the event
EARNINGS_LOOKAHEAD_DAYS = 16           # a date disagreement or a missing source inside this many days blocks buys
EARNINGS_MOVES_USED = 8
MIN_EARNINGS_MOVES = 4
MIN_WEEKEND_SAMPLES = 26
WEEKEND_PERCENTILE = 90
BLOCK_BEFORE_S = 60 * 60
BLOCK_AFTER_S = 30 * 60
UNCONFIRMED_BLOCK_S = 24 * 3_600
EARNINGS_AGREE_DAYS = 1

# Conservative defaults used (and flagged) when history is too short.
EARNINGS_MOVE_DEFAULT = {"default": 0.06, "TSLA": 0.08, "NVDA": 0.07, "COIN": 0.10, "MSTR": 0.10}
WEEKEND_GAP_DEFAULT = {"default": 0.04, "SPY": 0.02, "QQQ": 0.025}

# Oracle rules mirrored from ODVolOracle.sol (the contract constants win; the engine checks them at start with an RPC).
MAX_STEP_BPS = 2_500
MIN_POST_INTERVAL_S = 30
MIN_VALIDITY_S = 300
MAX_VALIDITY_S = 7_200
DEFAULT_VALIDITY_S = 3_600
MAX_BUY_BLOCK_S = 3 * 86_400
HARD_MIN_FLOOR_BPS = 500
HARD_MAX_CEILING_BPS = 30_000
RACE_CEILING_BPS = 4_000               # spec: Race markets only below 40% vol
RACE_MARKETS: frozenset[str] = frozenset()  # keys whose ceiling is RACE_CEILING_BPS; empty until a Race market is listed
BOUNDS_REFRESH_S = 3_600

# Cadence and freshness.
MIN_RELATIVE_CHANGE = 0.01
RENEW_FRACTION = 0.25                  # re-post when the last post has under this share of its validity left
MAX_TICK_AGE_S = 25 * 60               # two indexer heartbeats plus 5 minutes
PENDING_TTL_S = 15 * 60                # a sent post with no receipt after this long is dropped and replanned
ALERT_REPEAT_S = 6 * 3_600
LOOKBACK_DAYS = 45
CLOCK_SKEW_LIMIT_S = 600               # wall clock vs latest block beyond this: a warped fork

# Floors (a proposal for the owner; D22 sets SPY and QQQ at 15%). They must sit at or above the on-chain floor.
# Source: spec section 3 (30% mega-caps, 45% others) with D22 for the index ETFs, and 40% for the two crypto names.
FLOOR_CRYPTO = 0.40
FLOOR_INDEX_ETF = 0.15
FLOOR_MEGA = 0.30
FLOOR_RETAIL = 0.45
FLOOR_PAIR = 0.30
CRYPTO = frozenset({"ETH", "BTC"})
INDEX_ETFS = frozenset({"SPY", "QQQ"})
MEGA_CAPS = frozenset({"NVDA", "TSLA", "AAPL", "MSFT", "META", "AMZN", "AMD"})
RETAIL = frozenset({"COIN", "MSTR", "PLTR", "HOOD"})
NO_EARNINGS = frozenset({"SPY", "QQQ"}) | CRYPTO

# The listed markets (docs/research/feeds.json; HOOD dropped) and the launch pair gears (A over B).
LISTED_NAMES: tuple[str, ...] = ("ETH", "BTC", "TSLA", "NVDA", "SPY", "QQQ", "AAPL", "MSFT", "META", "AMZN",
                                 "COIN", "MSTR", "PLTR", "AMD")
LISTED_PAIRS: tuple[tuple[str, str], ...] = (("NVDA", "AMD"), ("QQQ", "SPY"), ("COIN", "MSTR"))

KNOWN_ENV = frozenset({
    "VOL_SIGNER_KEYSTORE", "VOL_SIGNER_KEYSTORE_PASSWORD_FILE", "VOL_SIGNER_KEY",
    "VOL_SENDER_KEYSTORE", "VOL_SENDER_KEYSTORE_PASSWORD_FILE", "VOL_SENDER_KEY",
    "VOL_ORACLE_ADDRESS", "VOL_CHAIN_ID", "VOL_RPC_URL", "VOL_SEND", "VOL_CLOCK", "VOL_KEYS",
    "VOL_MIN_POST_INTERVAL_S", "VOL_MAX_VALIDITY_S", "VOL_VALIDITY_S", "VOL_CONFIG_DIR",
})

# VOL_* names that belong to another service and sit in the same shared server env file
# (app/scripts/server/env.example). The engine ignores them; any other unknown VOL_* name still refuses.
FOREIGN_ENV = frozenset({
    "VOL_STALE_WARN_SECONDS",  # the crank's vol-watch job (app/src/config.ts)
})


def is_pair(key: str) -> bool:
    return "/" in key


def kind_of(key: str) -> str:
    """'crypto' when every leg is crypto, else 'equity' (a mixed pair only has regular-hours bars)."""
    legs = key.upper().split("/")
    return "crypto" if all(leg in CRYPTO for leg in legs) else "equity"


def floor_for(key: str) -> float:
    k = key.upper()
    if is_pair(k):
        return FLOOR_PAIR
    if k in CRYPTO:
        return FLOOR_CRYPTO
    if k in INDEX_ETFS:
        return FLOOR_INDEX_ETF
    if k in RETAIL:
        return FLOOR_RETAIL
    return FLOOR_MEGA


def default_keys() -> tuple[str, ...]:
    return LISTED_NAMES + tuple(f"{a}/{b}" for a, b in LISTED_PAIRS)


def parse_vol_keys(raw: str) -> tuple[tuple[str, ...], tuple[tuple[str, str], ...]]:
    """VOL_KEYS ("NVDA,NVDA/AMD=0x..."): the keys to post (default_keys() when empty) and the 0x bytes32 overrides.
    Refuses a key with no market id (see signer.market_key), so the engine never starts posting under a key nothing reads."""
    from .signer import market_key
    keys: list[str] = []
    overrides: list[tuple[str, str]] = []
    for item in (x.strip() for x in raw.split(",")):
        if not item:
            continue
        name, _, market = item.partition("=")
        name = name.strip().upper()
        if market:
            market = market.strip().lower()
            if len(market) != 66 or not market.startswith("0x"):
                raise KeyConfigError(f"VOL_KEYS: {name} override must be a 0x bytes32")
            overrides.append((name, market))
        keys.append(name)
    out = tuple(dict.fromkeys(keys)) or default_keys()
    named = {n for n, _ in overrides}
    for k in out:
        if k in named:
            continue
        for leg in k.split("/"):
            if leg in named:
                continue
            try:
                market_key(leg)
            except ValueError as exc:
                raise KeyConfigError(f"VOL_KEYS: {k}: {exc}") from None
    return out, tuple(overrides)


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default="", repr=False)
    signer_key: str = field(default="", repr=False)
    sender_key: str = field(default="", repr=False)
    oracle_address: str = ""
    chain_id: int = 4663
    rpc_url: str = ""
    send: bool = False
    validity_s: int = DEFAULT_VALIDITY_S
    min_post_interval_s: int = MIN_POST_INTERVAL_S
    max_validity_s: int = MAX_VALIDITY_S
    keys: tuple[str, ...] = default_keys()
    market_overrides: tuple[tuple[str, str], ...] = ()   # (key, 0x market) from VOL_KEYS entries like NVDA=0x...
    clock: str = "wall"                                  # "wall" or "chain" (a warped fork)
    config_dir: str = ""
    production: bool = False

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        unknown = sorted(k for k in e if k.startswith("VOL_") and k not in KNOWN_ENV and k not in FOREIGN_ENV)
        if unknown:
            raise KeyConfigError("unknown environment variable(s): " + ", ".join(unknown))
        keys, overrides = parse_vol_keys(e.get("VOL_KEYS", ""))
        clock = e.get("VOL_CLOCK", "wall").strip().lower()
        if clock not in ("wall", "chain"):
            raise KeyConfigError("VOL_CLOCK must be wall or chain")
        s = Settings(
            database_url=e.get("DATABASE_URL", ""),
            signer_key=load_key("VOL_SIGNER_KEY", "VOL_SIGNER", e),
            sender_key=load_key("VOL_SENDER_KEY", "VOL_SENDER", e),
            oracle_address=e.get("VOL_ORACLE_ADDRESS", ""),
            chain_id=int(e.get("VOL_CHAIN_ID", "4663")),
            rpc_url=e.get("VOL_RPC_URL", ""),
            send=e.get("VOL_SEND", "0") == "1",  # only the exact string "1" turns sending on
            validity_s=int(e.get("VOL_VALIDITY_S", str(DEFAULT_VALIDITY_S))),
            min_post_interval_s=int(e.get("VOL_MIN_POST_INTERVAL_S", str(MIN_POST_INTERVAL_S))),
            max_validity_s=int(e.get("VOL_MAX_VALIDITY_S", str(MAX_VALIDITY_S))),
            keys=keys,
            market_overrides=overrides,
            clock=clock,
            config_dir=e.get("VOL_CONFIG_DIR", ""),
            production=e.get("NODE_ENV", "").strip() == "production",
        )
        s.check_distinct_keys()
        return s

    def check_distinct_keys(self) -> None:
        """The gas wallet must not be the signer: a leaked relay key must not be able to post sigma."""
        if self.signer_key and self.sender_key:
            from .signer import signer_address
            if signer_address(self.signer_key) == signer_address(self.sender_key):
                raise KeyConfigError("the sender wallet must differ from the signer (VOL_SENDER_* vs VOL_SIGNER_*)")
        if self.send and not self.sender_key:
            raise KeyConfigError("VOL_SEND=1 needs a sender wallet (VOL_SENDER_KEYSTORE or VOL_SENDER_KEY)")

    def secrets(self) -> list[str]:
        return [s for s in (self.signer_key, self.sender_key) if s]
