"""Price paths: a list of Steps. Builders for gaps, ramps, candle replays and seeded random walks (PCG64 only)."""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class Step:
    dt_s: float                              # time elapsed over the step (0 = an instantaneous gap)
    returns: dict = field(default_factory=dict)   # underlying -> simple return over the step
    venue_up: bool = True
    slip_mult: float = 1.0
    posted_sigma: dict | None = None         # key -> sigma used for toll income in this step (None: the book's posted sigma)


def gap(returns: dict, venue_up: bool = False) -> list[Step]:
    return [Step(0.0, dict(returns), venue_up)]


def tail(seconds: float, venue_up: bool = True) -> list[Step]:
    return [Step(float(seconds), {}, venue_up)]


def ramp(returns: dict, seconds: float, n: int, venue_up: bool = True, slip_mult: float = 1.0) -> list[Step]:
    """Spread each total return over n equal geometric steps."""
    per = {k: (1.0 + r) ** (1.0 / n) - 1.0 for k, r in returns.items()}
    return [Step(seconds / n, dict(per), venue_up, slip_mult) for _ in range(n)]


def split_effective_ratio(k: float, feed_embeds_multiplier: bool, protocol_applies_multiplier: bool, times: int = 1) -> float:
    """Effective price ratio the protocol sees on a k:1 split day (k=2 forward 2:1, k=0.1 reverse 1:10).
    The economic price is unchanged. A feed that embeds the multiplier shows the unchanged price; one that does not shows P/k and
    the protocol must multiply by k. Correct handling gives exactly 1. Applying the multiplier `times` extra times gives k**times."""
    raw = 1.0 if feed_embeds_multiplier else 1.0 / k
    mult = k if protocol_applies_multiplier else 1.0
    ratio = raw * mult
    return ratio * (k ** (times - 1)) if protocol_applies_multiplier and times > 1 else ratio


def load_candles(path: Path, symbols: tuple[str, ...]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {s: [] for s in symbols}
    if not Path(path).exists():
        return out
    with Path(path).open() as f:
        for row in csv.DictReader(f):
            if row["symbol"] in out:
                out[row["symbol"]].append({"t": row.get("ts") or row.get("date"), "o": float(row["open"]), "h": float(row["high"]),
                                           "l": float(row["low"]), "c": float(row["close"])})
    return out


def candle_points(c: dict) -> list[float]:
    """Intra-candle order, worst for a down move first: open, high, low, close when it closed down, else open, low, high, close."""
    return [c["o"], c["h"], c["l"], c["c"]] if c["c"] < c["o"] else [c["o"], c["l"], c["h"], c["c"]]


def candle_path(series: dict[str, list[dict]], candle_s: float, outage: tuple[int, int] | None = None, outage_slip: float = 1.0) -> list[Step]:
    """One Step per quarter candle. All series must have the same candle count. outage = (first, last) candle index with no venue."""
    n = min(len(v) for v in series.values())
    steps: list[Step] = []
    prev = {k: v[0]["o"] for k, v in series.items()}
    for i in range(n):
        pts = {k: candle_points(v[i]) for k, v in series.items()}
        for j in range(1, 4):
            rets = {k: pts[k][j] / prev[k] - 1.0 for k in series}
            for k in series:
                prev[k] = pts[k][j]
            down = outage is not None and outage[0] <= i <= outage[1]
            steps.append(Step(candle_s / 3.0, rets, not down, outage_slip if down else 1.0))
        # candle open to open continuity: next open is this close, no gap by construction
    return steps


def random_walk(names: dict[str, float], hours: float, step_s: float, seed: int) -> list[Step]:
    """Seeded Gaussian log-return path; names maps underlying -> annual vol. numpy.random.Generator(PCG64(seed)) only."""
    rng = np.random.Generator(np.random.PCG64(seed))
    n = int(hours * 3600 / step_s)
    dt = step_s / (365 * 86_400)
    keys = sorted(names)
    z = rng.standard_normal((n, len(keys)))
    return [Step(step_s, {k: math.exp(names[k] * math.sqrt(dt) * z[i, j] - 0.5 * names[k] ** 2 * dt) - 1.0 for j, k in enumerate(keys)})
            for i in range(n)]
