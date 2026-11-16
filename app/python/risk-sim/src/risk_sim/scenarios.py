"""The eight nightly scenarios. Each builds cases (a path plus a hedge mode); run_scenario simulates them and keeps the worst.
Holders are never liquidated here: the book is immutable and nothing in this module writes a balance (R9)."""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

from . import config as C
from .book import Book
from .exit_reserve import exit_run
from .governor import PathResult, _gear_value, simulate
from .hedge_model import HedgeModel
from .paths import (Step, candle_path, gap, load_candles, ramp, random_walk, split_effective_ratio, tail)
from .toll import YEAR_S


@dataclass
class Context:
    data_dir: Path = C.DATA_DIR
    seed: int = C.Settings().seed
    jan31_target: str = "2026-01-31"
    vol_paths: int = 8


@dataclass
class Case:
    label: str
    path: list
    mode: str = "policy"          # policy (hedger runs) | no_venue (position held, never trades) | unhedged (no position, never trades)
    counts: bool = True           # toward the cap plan; misconfig demos and unhedged references do not
    tag: str = ""


@dataclass
class Scenario:
    name: str
    title: str
    build: object                 # callable(book, ctx) -> Built


@dataclass
class Built:
    cases: list = field(default_factory=list)
    moves: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    status: str = "ok"
    extra: dict = field(default_factory=dict)
    direct: list | None = None     # precomputed case dicts (split day, exit run), no path simulation


@dataclass
class ScenarioResult:
    name: str
    title: str
    status: str
    cases: list
    worst_loss: float
    worst_case: str
    by_name: dict
    moves: list
    notes: list
    flags: list
    extra: dict


def _case_dict(label, res: PathResult, counts, mode, tag="") -> dict:
    return {"label": label, "loss": round(res.loss, 6), "pnl": round(res.pnl, 6), "hedge_pnl": round(res.hedge_pnl, 6),
            "gear_pnl": round(res.gear_pnl, 6), "income": round(res.income, 6), "costs": round(res.costs, 6), "rehedges": res.rehedges,
            "counts": counts, "mode": mode, "tag": tag, "by_name": {k: round(v, 6) for k, v in sorted(res.by_name.items())},
            "value_change": round(res.value_change, 6)}


def run_scenario(book: Book, sc: Scenario, hedge: HedgeModel, ctx: Context | None = None) -> ScenarioResult:
    ctx = ctx or Context()
    built: Built = sc.build(book, ctx, hedge) if getattr(sc.build, "wants_hedge", False) else sc.build(book, ctx)
    if built.status != "ok":
        return ScenarioResult(sc.name, sc.title, built.status, [], 0.0, "", {}, built.moves, built.notes, [built.status], built.extra)
    cases = list(built.direct or [])
    for c in built.cases:
        h = hedge if c.mode == "policy" else hedge.off()
        start = {} if c.mode == "unhedged" else None
        cases.append(_case_dict(c.label, simulate(book, c.path, h, start), c.counts, c.mode, c.tag))
    counted = [c for c in cases if c["counts"]]
    worst = max(counted, key=lambda c: (c["loss"], c["label"]), default=None)
    flags = sorted({f for c in cases for f in (["misconfig_demo"] if c["tag"] == "misconfig_demo" else [])})
    flags += list(built.extra.get("flags", []))
    if book.hedge_stale:
        flags.append("hedge_stale")
    return ScenarioResult(sc.name, sc.title, "ok", cases, worst["loss"] if worst else 0.0, worst["label"] if worst else "",
                          worst["by_name"] if worst else {}, built.moves, built.notes, sorted(set(flags)), built.extra)


# ---------------------------------------------------------------- data helpers

@lru_cache(maxsize=8)
def _read_daily(path: str, mtime: float) -> dict:
    out: dict[str, list] = {}
    with open(path) as f:
        for row in csv.DictReader(f):
            out.setdefault(row["symbol"], []).append((row["date"], float(row["close"])))
    return {k: sorted(v) for k, v in out.items()}


def daily(ctx: Context) -> dict | None:
    p = Path(ctx.data_dir) / "daily.csv"
    if not p.exists() or p.stat().st_size < 100:
        return None
    return _read_daily(str(p), p.stat().st_mtime)


def _mirror(m: dict) -> dict:
    return {k: -v for k, v in m.items()}


def _hedge_variants(label: str, path_gap: list, tail_s: float = 7200.0) -> list:
    return [Case(f"{label}:hedged_no_venue", path_gap, "no_venue"),
            Case(f"{label}:hedged_24x7", path_gap + tail(tail_s, True), "policy"),
            Case(f"{label}:unhedged", path_gap, "unhedged", counts=False)]


# ---------------------------------------------------------------- scenarios

def build_oct10(book: Book, ctx: Context) -> Built:
    f = Path(ctx.data_dir) / "oct10_2025_5m.csv"
    series = load_candles(f, ("ETH", "BTC")) if f.exists() else {"ETH": [], "BTC": []}
    if any(len(v) < 12 for v in series.values()):
        return Built(status="data_missing", notes=[f"no candles in {f.name}: run `risk-sim fetch-history`"])
    n = min(len(v) for v in series.values())
    series = {k: v[:n] for k, v in series.items()}
    low_i = min(range(n), key=lambda i: series["ETH"][i]["l"])
    half = C.OCT10_OUTAGE_S // 300 // 2
    outage = (max(0, low_i - half // 2), min(n - 1, low_i + half + half // 2))
    moves = [{"name": k, "open": v[0]["o"], "low": min(c["l"] for c in v), "high": max(c["h"] for c in v), "close": v[-1]["c"],
              "window_candles": n, "window_hours": n * 5 / 60} for k, v in sorted(series.items())]
    path = candle_path(series, 300.0, outage, C.OCT10_SPREAD_MULT)
    notes = [f"venue outage assumed {C.OCT10_OUTAGE_S}s around the ETH low (candles {outage[0]}..{outage[1]}), spreads x{C.OCT10_SPREAD_MULT} inside it",
             "stocks are held flat on this scenario; only the ETH and BTC path is replayed"]
    return Built([Case("path:hedger_with_outage", path, "policy"), Case("path:unhedged", path, "unhedged", counts=False)], moves, notes)


def build_jan31(book: Book, ctx: Context) -> Built:
    d = daily(ctx)
    if d is None:
        return Built(status="data_missing", notes=["no daily.csv: run `risk-sim fetch-history`"])
    target = date.fromisoformat(ctx.jan31_target)
    lo, hi = (target - timedelta(days=C.JAN31_WINDOW_DAYS)).isoformat(), (target + timedelta(days=C.JAN31_WINDOW_DAYS)).isoformat()
    one, three, on_target = {}, {}, {}
    for name, rows in d.items():
        for i, (dt, c) in enumerate(rows):
            if i == 0 or not lo <= dt <= hi:
                continue
            r1 = c / rows[i - 1][1] - 1.0
            if abs(r1) > abs(one.get(name, 0.0)):
                one[name] = r1
            if i >= 3:
                r3 = c / rows[i - 3][1] - 1.0
                if abs(r3) > abs(three.get(name, 0.0)):
                    three[name] = r3
            if dt == ctx.jan31_target:
                on_target[name] = r1
    notes = ["the spec gives only the date 2026-01-31: replayed as the measured worst 1-day and 3-day moves within +-3 days (TODO: the owner to name the event)"]
    stress = max((abs(v) for v in one.values()), default=0.0) >= C.JAN31_MIN_STRESS
    if not stress:
        notes.append("the data shows no stress in the window; fell back to the worst 3-day move per name over the last 2 years")
        three, one = {}, {}
        for name, rows in d.items():
            for i in range(3, len(rows)):
                r3 = rows[i][1] / rows[i - 3][1] - 1.0
                if abs(r3) > abs(three.get(name, 0.0)) and r3 < 0:
                    three[name] = r3
        one = {k: v / 3 for k, v in three.items()}
    names = set(book.underlyings)
    moves = [{"name": k, "worst_1d": round(one.get(k, 0.0), 6), "worst_3d": round(three.get(k, 0.0), 6),
              "on_2026-01-31": round(on_target[k], 6) if k in on_target else None, "window": f"{lo}..{hi}" if stress else "last_2_years",
              "applied": k in names} for k in sorted(d)]
    cases = []
    for horizon, mv, secs, n in (("1d", one, 86400.0, 24), ("3d", three, 259200.0, 36)):
        m = {k: v for k, v in mv.items() if k in names}
        for sign, mm in (("actual", m), ("mirror", _mirror(m))):
            p = ramp(mm, secs, n)
            cases.append(Case(f"{horizon}_{sign}:hedger", p, "policy"))
            cases.append(Case(f"{horizon}_{sign}:unhedged", p, "unhedged", counts=False))
    return Built(cases, moves, notes, extra={"stress_found": stress})


def build_single_stock(book: Book, ctx: Context) -> Built:
    g = C.SINGLE_STOCK_GAP
    cases, moves = [], []
    for s in book.stocks:
        for sign in (-1, 1):
            r = {s: sign * g}
            cases += _hedge_variants(f"{s}:{'+' if sign > 0 else '-'}{g * 100:.1f}%", gap(r, venue_up=False))
            moves.append({"name": s, "gap": sign * g})
    return Built(cases, moves, [f"every stock gaps {g * 100:.1f}% at the open after a closed session, and the mirror; hedger blind at the gap, "
                                "24x7 variant may rehedge afterwards"])


def build_split(book: Book, ctx: Context) -> Built:
    direct, moves = [], []
    v0 = book.total_governor_value()
    base = {n: 1.0 for n in book.underlyings}

    def total(ratios):
        return sum(_gear_value(g, ratios) for g in book.gears)

    for s in book.stocks:
        for k in C.SPLIT_RATIOS:
            for embeds in (True, False):
                good = dict(base)
                good[s] = split_effective_ratio(k, embeds, protocol_applies_multiplier=not embeds)
                dv = total(good) - v0
                direct.append({"label": f"{s}:{k:g}:1:{'embeds' if embeds else 'raw'}:correct", "loss": round(max(0.0, dv), 9), "pnl": 0.0,
                               "counts": True, "mode": "direct", "tag": "", "by_name": {}, "value_change": round(dv, 9)})
                bad = dict(base)
                bad[s] = split_effective_ratio(k, embeds, protocol_applies_multiplier=True, times=2) if embeds else k
                dvb = total(bad) - v0
                direct.append({"label": f"{s}:{k:g}:1:{'embeds' if embeds else 'raw'}:double_applied", "loss": round(max(0.0, dvb), 6), "pnl": 0.0,
                               "counts": False, "mode": "direct", "tag": "misconfig_demo", "by_name": {}, "value_change": round(dvb, 6)})
            moves.append({"name": s, "split": k})
    broken = [d["label"] for d in direct if d["tag"] == "" and abs(d["value_change"]) > 1e-9 * max(v0, 1.0)]
    return Built(direct=direct, moves=moves, extra={"flags": ["split_value_changed"] if broken else []}, notes=["correct handling leaves gear value unchanged; double_applied rows prove why the per-feed flag exists "
                                                      "and are marked misconfig_demo (never counted toward caps)"])


def build_weekend(book: Book, ctx: Context) -> Built:
    g = C.WEEKEND_GAP
    cases = []
    for sign in (1, -1):
        r = {s: sign * g for s in book.stocks}
        cases += _hedge_variants(f"all_stocks:{'+' if sign > 0 else '-'}{g * 100:.0f}%", gap(r, venue_up=False))
    return Built(cases, [{"name": s, "gap": g} for s in book.stocks], [f"all stocks +-{g * 100:.0f}% together at the Monday open, both ways"])


def build_vol_spike(book: Book, ctx: Context) -> Built:
    keys = sorted({k for g in book.gears for k in [g.key]})
    names = sorted(book.underlyings)
    sig = {n: book.sigma(n)[0] for n in names}
    missing = [n for n in names if book.sigma(n)[1]]
    spiked = {n: 2.0 * v for n, v in sig.items()}
    hours = 72.0
    cases = []
    for i in range(ctx.vol_paths):
        base = random_walk(spiked, hours, 1800.0, ctx.seed + i)
        steps, t = [], 0.0
        for st in base:
            t += st.dt_s
            k_posts = int(t // C.SIGMA_POST_INTERVAL_S) + 1
            posted = {}
            for key in keys:
                s0 = book.sigma(key)[0]
                posted[key] = min(2.0 * s0, s0 * (1.0 + C.SIGMA_STEP_LIMIT) ** k_posts)
            steps.append(Step(st.dt_s, st.returns, True, 1.0, posted))
        cases.append(Case(f"path_{i}:hedger", steps, "policy"))
    notes = [f"realised vol x2 for {hours:.0f}h, posted sigma lags by +{C.SIGMA_STEP_LIMIT * 100:.0f}% per post every {C.SIGMA_POST_INTERVAL_S // 3600}h",
             f"{ctx.vol_paths} seeded paths (PCG64, seed {ctx.seed})"]
    return Built(cases, [{"name": n, "posted_sigma": sig[n], "spiked_sigma": spiked[n]} for n in names], notes,
                 extra={"flags": [f"sigma_missing:{n}" for n in missing]})


def build_outage(book: Book, ctx: Context) -> Built:
    cases = []
    for sign in (1, -1):
        r = {n: sign * C.OUTAGE_MOVE for n in book.underlyings}
        p = ramp(r, C.OUTAGE_S, 6, venue_up=False) + tail(3600.0, True)
        lab = f"all:{'+' if sign > 0 else '-'}{C.OUTAGE_MOVE * 100:.0f}%"
        cases += [Case(f"{lab}:both_venues_down", p, "policy"), Case(f"{lab}:unhedged", p, "unhedged", counts=False)]
    return Built(cases, [{"name": n, "move": C.OUTAGE_MOVE} for n in book.underlyings], ["both venues down for 30 minutes during a 5% move, then up for 1h"])


def build_exit(book: Book, ctx: Context, hedge: HedgeModel | None = None) -> Built:
    row, ok = exit_run(book, C.SINGLE_STOCK_GAP)
    return Built(direct=[{"label": "exit_run:all_holders_sell", "loss": 0.0, "pnl": 0.0, "counts": False, "mode": "direct", "tag": "", "by_name": {},
                          "value_change": 0.0}], notes=["every holder sells at once at the stressed price; the ring-fenced reserve must cover it"],
                 extra={"exit": row, "flags": [] if ok else ["exit_reserve_short"]})


SCENARIOS: dict[str, Scenario] = {
    "oct_10_2025": Scenario("oct_10_2025", "Crypto liquidation cascade, 10 Oct 2025", build_oct10),
    "jan_31_2026": Scenario("jan_31_2026", "31 Jan 2026 (measured worst moves, window +-3 days)", build_jan31),
    "single_stock_minus_18_7": Scenario("single_stock_minus_18_7", "Single stock gaps -18.7% (and the mirror)", build_single_stock),
    "split_day": Scenario("split_day", "Split day: 2:1, 3:1, 10:1, 1:10", build_split),
    "weekend_gap_both_ways": Scenario("weekend_gap_both_ways", "All stocks +-15% at the Monday open", build_weekend),
    "vol_spike_2x": Scenario("vol_spike_2x", "Realised vol doubles for 3 days, sigma posts lag", build_vol_spike),
    "venue_outage_30m": Scenario("venue_outage_30m", "Both venues down 30 minutes during a 5% move", build_outage),
    "exit_run": Scenario("exit_run", "Every holder sells at once", build_exit),
}


def run_all(book: Book, hedge: HedgeModel, ctx: Context | None = None, only: list | None = None) -> dict:
    return {n: run_scenario(book, sc, hedge, ctx) for n, sc in SCENARIOS.items() if only is None or n in only}


def worst_of(results: dict) -> tuple[float, str]:
    best = max(((r.worst_loss, n) for n, r in results.items() if r.status == "ok"), default=(0.0, ""))
    return best


def budget_flags(results: dict, budget: float) -> dict:
    """R16: a scenario whose worst loss exceeds the contract's stress budget by more than 20% is `contract_budget_too_loose`."""
    return {n: ["contract_budget_too_loose"] for n, r in results.items() if r.status == "ok" and r.worst_loss > budget * 1.2}
