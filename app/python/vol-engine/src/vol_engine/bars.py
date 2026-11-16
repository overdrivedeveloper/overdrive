"""5-minute bars and overnight gaps from price rows.

Equities use REGULAR-session rows only (extended-hours prints and other sessions are dropped and counted, so the caller can
flag them); each ET day is forward-filled between its first and last bucket, so a feed that prints on a 0.5% deviation or a
heartbeat still yields a bar per 5 minutes. ETH and BTC use every row, 24/7, forward-filled across the whole span.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Iterable
from zoneinfo import ZoneInfo

from .config import BAR_SECONDS, CRYPTO_BARS_PER_DAY, CRYPTO_DAYS_PER_YEAR, EQUITY_BARS_PER_DAY, EQUITY_DAYS_PER_YEAR

ET = ZoneInfo("America/New_York")
REGULAR = "REGULAR"
EXTENDED = "EXTENDED"


@dataclass(frozen=True)
class Tick:
    ts: float      # unix seconds
    price: float   # USD per share (or per coin, or a ratio for a pair)
    session: str   # REGULAR | EXTENDED | CLOSED | UNKNOWN | HALTED
    fresh: bool = True


@dataclass
class Bars:
    """Log returns keyed by 5-minute bucket, and close-to-open gaps keyed by ET day ordinal (equities)."""
    kind: str = "equity"
    ret_keys: list[int] = field(default_factory=list)
    returns: list[float] = field(default_factory=list)
    gap_keys: list[int] = field(default_factory=list)
    gaps: list[float] = field(default_factory=list)
    excluded_extended: int = 0
    excluded_other: int = 0

    @property
    def bars_per_day(self) -> int:
        return CRYPTO_BARS_PER_DAY if self.kind == "crypto" else EQUITY_BARS_PER_DAY

    @property
    def days_per_year(self) -> int:
        return CRYPTO_DAYS_PER_YEAR if self.kind == "crypto" else EQUITY_DAYS_PER_YEAR


def et_day(ts: float) -> date:
    return datetime.fromtimestamp(ts, ET).date()


def _valid(price: float) -> bool:
    return price > 0.0 and math.isfinite(price)


def build_equity_bars(ticks: Iterable[Tick]) -> Bars:
    out = Bars("equity")
    per_day: dict[date, dict[int, float]] = {}
    first: dict[date, float] = {}
    last: dict[date, float] = {}
    for t in sorted(ticks, key=lambda x: x.ts):
        if t.session == EXTENDED:
            out.excluded_extended += 1
            continue
        if t.session != REGULAR or not _valid(t.price):
            out.excluded_other += 1
            continue
        d = et_day(t.ts)
        per_day.setdefault(d, {})[int(t.ts // BAR_SECONDS)] = t.price
        first.setdefault(d, t.price)
        last[d] = t.price
    prev_close: float | None = None
    for d in sorted(per_day):
        buckets = per_day[d]
        lo, hi = min(buckets), max(buckets)
        px = buckets[lo]
        prev = px
        for b in range(lo + 1, hi + 1):
            px = buckets.get(b, px)
            out.ret_keys.append(b)
            out.returns.append(math.log(px / prev))
            prev = px
        if prev_close is not None:
            out.gap_keys.append(d.toordinal())
            out.gaps.append(math.log(first[d] / prev_close))
        prev_close = last[d]
    return out


def build_crypto_bars(ticks: Iterable[Tick]) -> Bars:
    out = Bars("crypto")
    buckets: dict[int, float] = {}
    for t in sorted(ticks, key=lambda x: x.ts):
        if not _valid(t.price):
            out.excluded_other += 1
            continue
        buckets[int(t.ts // BAR_SECONDS)] = t.price
    if not buckets:
        return out
    lo, hi = min(buckets), max(buckets)
    px = buckets[lo]
    for b in range(lo + 1, hi + 1):
        new = buckets.get(b, px)
        out.ret_keys.append(b)
        out.returns.append(math.log(new / px))
        px = new
    return out


def build_bars(kind: str, ticks: Iterable[Tick]) -> Bars:
    return build_crypto_bars(ticks) if kind == "crypto" else build_equity_bars(ticks)


def ratio_ticks(a: Iterable[Tick], b: Iterable[Tick]) -> list[Tick]:
    """Ticks of price A over price B: at every row of either leg, the latest price of each. The session is REGULAR only when
    both legs are, EXTENDED when either is, so the equity builder drops the same rows it would drop for a single name."""
    events = sorted([(t.ts, 0, t) for t in a] + [(t.ts, 1, t) for t in b], key=lambda e: (e[0], e[1]))
    la: Tick | None = None
    lb: Tick | None = None
    out: list[Tick] = []
    for _, leg, t in events:
        if leg == 0:
            la = t
        else:
            lb = t
        if la is None or lb is None or not (_valid(la.price) and _valid(lb.price)):
            continue
        if REGULAR == la.session == lb.session:
            session = REGULAR
        elif EXTENDED in (la.session, lb.session):
            session = EXTENDED
        else:
            session = la.session if la.session != REGULAR else lb.session
        out.append(Tick(t.ts, la.price / lb.price, session, la.fresh and lb.fresh))
    return out
