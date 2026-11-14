"""R8: recommended caps. The spec's starting maxima are scaled down (never up) by one factor per group, then by one common
factor if the combined worst scenario loss is still above the limit. Caps are evaluated at full utilisation (open = cap)."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from .book import Book, GearPos
from .config import SPEC_GROUPS
from .governor import netting
from .hedge_model import HedgeModel
from .scenarios import Context, run_all, worst_of


def group_of(key: str) -> str:
    for name, g in SPEC_GROUPS.items():
        if key in g["members"]:
            return name
    raise KeyError(f"no cap group for {key}")


@dataclass
class CapPlan:
    equity_usd: float
    limit_usd: float
    worst_loss_usd: float
    factors: dict = field(default_factory=dict)
    caps: list = field(default_factory=list)       # [{gear, key, power, group, cap_usd, spec_max_usd, factor, spread_bps}]
    notes: list = field(default_factory=list)


def universe(template: Book | None, groups: tuple[str, ...] | None = None, scale: dict | None = None) -> list[GearPos]:
    """Every spec gear at full utilisation, restricted to the names the template book lists (all names when None)."""
    names = None if template is None or not template.gears else {g.key for g in template.gears}
    gears = []
    for gname, grp in SPEC_GROUPS.items():
        if groups is not None and gname not in groups:
            continue
        f = (scale or {}).get(gname, 1.0)
        for member in grp["members"]:
            if names is not None and member not in names:
                continue
            for p in grp["powers"]:
                v = grp["cap_usd"] * f
                gears.append(GearPos(id=f"{member}:{p:g}", key=member, power=p, supply_tokens=v, backer_debt_tokens=0.0,
                                     value_per_token=1.0, cap_usd=grp["cap_usd"]))
    return gears


def _loss(template: Book, gears: list[GearPos], hedge: HedgeModel, ctx: Context, only: list | None = None) -> float:
    if not gears:
        return 0.0
    pos = {u: d for u, (d, _g) in netting(gears).items()}
    b = replace(template, gears=tuple(gears), hedge_position_usd=pos, hedge_stale=False,
                exit_reserve_usd=float("inf"), exit_reserve_floor_usd=0.0)
    h = replace(hedge, band_ref_usd=max(b.total_governor_value(), 1.0))     # band scales with the book: loss is exactly linear in f
    return worst_of(run_all(b, h, ctx, only))[0]


def recommend_caps(book: Book, results=None, max_loss_bps: int = 1500, group_weights: dict | None = None,
                   hedge: HedgeModel | None = None, ctx: Context | None = None) -> CapPlan:
    hedge = hedge or HedgeModel()
    ctx = ctx or Context(vol_paths=3)
    limit = max(book.equity_usd, 0.0) * max_loss_bps / 1e4
    gears = universe(book)
    groups = sorted({group_of(g.key) for g in gears})
    plan = CapPlan(book.equity_usd, limit, 0.0)
    if book.equity_usd <= 0 or not gears:
        plan.factors = {g: 0.0 for g in groups}
        plan.notes.append("zero equity: zero caps" if book.equity_usd <= 0 else "no gears")
    else:
        total_cap = sum(SPEC_GROUPS[g]["cap_usd"] * sum(1 for x in gears if group_of(x.key) == g) for g in groups)
        weights = group_weights or {g: SPEC_GROUPS[g]["cap_usd"] * sum(1 for x in gears if group_of(x.key) == g) / total_cap for g in groups}
        factors = {}
        for g in groups:
            lg = _loss(book, universe(book, (g,)), hedge, ctx)
            factors[g] = 1.0 if lg <= 0 else min(1.0, limit * weights.get(g, 0.0) / lg)
        scaled = universe(book, None, factors)
        lc = _loss(book, scaled, hedge, ctx)
        s = 1.0 if lc <= limit or lc <= 0 else limit / lc
        lf = lc if s == 1.0 else limit
        for _ in range(6):
            final = {g: factors[g] * s for g in groups}
            lf = _loss(book, universe(book, None, final), hedge, ctx)
            if lf <= limit * (1 + 1e-12):
                break
            s *= 0.99 * limit / lf
        plan.factors = {g: factors[g] * s for g in groups}
        plan.worst_loss_usd = lf
    for g in gears:
        grp = SPEC_GROUPS[group_of(g.key)]
        f = plan.factors.get(group_of(g.key), 0.0)
        plan.caps.append({"gear": g.id, "key": g.key, "power": g.power, "group": group_of(g.key), "cap_usd": round(grp["cap_usd"] * f, 2),
                          "spec_max_usd": grp["cap_usd"], "factor": round(f, 9), "spread_bps": grp["spread_bps"]})
    return plan
