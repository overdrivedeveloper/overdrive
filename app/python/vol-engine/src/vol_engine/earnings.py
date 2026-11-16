"""Two-source earnings reconciliation and the buy-block window.

Sources (both free and independent):
  A  `calendar`    a public earnings calendar, synced into the `earnings_dates` table by the keeper.
  B  `company_ir`  dates the company itself published on its investor-relations page, kept by hand in
                   app/src/config/earnings-overrides.json.

A date is only trusted when both sources agree within one day. This module never invents a date.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Iterable, Sequence

from .bars import ET
from .config import (
    BLOCK_AFTER_S,
    BLOCK_BEFORE_S,
    EARNINGS_AGREE_DAYS,
    EARNINGS_LOOKAHEAD_DAYS,
    MAX_BUY_BLOCK_S,
    NO_EARNINGS,
    UNCONFIRMED_BLOCK_S,
)

SOURCE_A = "calendar"
SOURCE_B = "company_ir"

# Nominal report times in New York time. The sources only say pre or post market.
PRE_AT = time(8, 0)
POST_AT = time(16, 5)
IMMINENT = timedelta(days=EARNINGS_LOOKAHEAD_DAYS)


@dataclass(frozen=True)
class EarningsRow:
    symbol: str
    report_date: date
    session: str  # pre | post | unknown
    source: str


@dataclass
class EarningsDecision:
    status: str  # no_earnings | none | confirmed | disagree | missing_source
    report_date: date | None = None
    session: str = "unknown"
    candidates: list[tuple[date, str]] = field(default_factory=list)  # every date a source gave, for the higher-reading rule
    force_block: tuple[int, int] | None = None  # (from, to) unix seconds when buys are blocked pending confirmation
    alerts: list[tuple[str, dict]] = field(default_factory=list)


def _et(d: date, t: time) -> datetime:
    return datetime.combine(d, t, tzinfo=ET)


def report_times(report_date: date, session: str) -> tuple[int, int, int]:
    """(report_ts, block_from, block_to) in unix seconds: report - 60 min to report + 30 min.

    pre: report 08:00 ET. post: 16:05 ET. unknown: the window spans both, so it holds whichever it turns out to be."""
    pre, post = _et(report_date, PRE_AT), _et(report_date, POST_AT)
    before, after = timedelta(seconds=BLOCK_BEFORE_S), timedelta(seconds=BLOCK_AFTER_S)
    if session == "pre":
        report, lo, hi = pre, pre - before, pre + after
    elif session == "post":
        report, lo, hi = post, post - before, post + after
    else:
        report, lo, hi = pre, pre - before, post + after
    return int(report.timestamp()), int(lo.timestamp()), int(hi.timestamp())


def block_window(lo: int, hi: int, now_s: int) -> tuple[int, int]:
    """Clamp a window to what the contract accepts: from now or later, at most 3 days long; (0, 0) once it has passed."""
    if hi < now_s:
        return 0, 0
    lo = max(lo, now_s)
    return lo, min(hi, lo + MAX_BUY_BLOCK_S)


def _next(rows: Iterable[EarningsRow], today: date, source: str) -> EarningsRow | None:
    upcoming = [r for r in rows if r.source == source and r.report_date >= today]
    return min(upcoming, key=lambda r: r.report_date) if upcoming else None


def reconcile(symbol: str, rows: Sequence[EarningsRow], now: datetime) -> EarningsDecision:
    sym = symbol.upper()
    if sym in NO_EARNINGS:
        return EarningsDecision("no_earnings")
    today = now.astimezone(ET).date()
    a, b = _next(rows, today, SOURCE_A), _next(rows, today, SOURCE_B)
    now_s = int(now.timestamp())
    block = (now_s, now_s + UNCONFIRMED_BLOCK_S)
    soon = lambda r: r is not None and (r.report_date - today) <= IMMINENT  # noqa: E731
    detail = {SOURCE_A: a.report_date.isoformat() if a else None, SOURCE_B: b.report_date.isoformat() if b else None}
    cands = [(r.report_date, r.session) for r in (a, b) if r]

    if a is None and b is None:
        return EarningsDecision("none", alerts=[("earnings_no_source_dates", detail)])

    if a is None or b is None:
        present = a or b
        missing = SOURCE_A if a is None else SOURCE_B
        dec = EarningsDecision("missing_source", candidates=cands,
                               alerts=[("earnings_source_missing", {**detail, "missing": missing})])
        if soon(present):
            dec.force_block = block
        return dec

    if abs((a.report_date - b.report_date).days) > EARNINGS_AGREE_DAYS:
        dec = EarningsDecision("disagree", candidates=cands, alerts=[("earnings_sources_disagree", detail)])
        if soon(a) or soon(b):
            dec.force_block = block
        return dec

    # Agreement. Take the earlier date; trust the company's own session when it states one.
    date_ = min(a.report_date, b.report_date)
    session = b.session if b.session != "unknown" else a.session
    return EarningsDecision("confirmed", report_date=date_, session=session)
