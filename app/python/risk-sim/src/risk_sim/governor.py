"""Governor P&L on a path (R3), netting identical to the hedger (R2) and the on-chain stress rule (R16)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .book import Book, GearPos
from .hedge_model import HedgeModel
from .paths import Step
from .toll import YEAR_S, toll_per_year


def netting(gears) -> dict[str, tuple[float, float]]:
    """Per underlying (delta, gamma), todo 16 formulas: delta = pV, gamma = p(p-1)V. A pair gear adds +pV and p(p-1)V on A,
    -pV and p(p+1)V on B (diagonal terms; the cross term is not traded and is ignored here as in the hedger)."""
    out: dict[str, list[float]] = {}
    for g in gears:
        v = g.governor_value_usd
        p = g.power
        if g.is_pair:
            a, b = g.legs
            for leg, d, gm in ((a, p * v, p * (p - 1) * v), (b, -p * v, p * (p + 1) * v)):
                row = out.setdefault(leg, [0.0, 0.0])
                row[0] += d
                row[1] += gm
        else:
            row = out.setdefault(g.key, [0.0, 0.0])
            row[0] += p * v
            row[1] += p * (p - 1) * v
    return {k: (v[0], v[1]) for k, v in out.items()}


@dataclass
class PathResult:
    pnl: float = 0.0
    loss: float = 0.0                       # worst point of cumulative P&L along the path, as a positive number
    hedge_pnl: float = 0.0
    gear_pnl: float = 0.0
    income: float = 0.0
    costs: float = 0.0
    rehedges: int = 0
    equity_start: float = 0.0
    equity_end: float = 0.0
    by_name: dict = field(default_factory=dict)       # worst-point attribution is not needed: end-of-path P&L by underlying or pair
    value_change: float = 0.0               # total Governor-backed gear value end minus start (split-day invariant)


def _gear_value(g: GearPos, ratios: dict) -> float:
    r = ratios[g.legs[0]] / (ratios[g.legs[1]] if g.is_pair else 1.0)
    return g.governor_value_usd * r**g.power


def simulate(book: Book, path: list[Step], hedge: HedgeModel, start_hedge: dict | None = None) -> PathResult:
    """Governor P&L = hedge P&L - change in value of Governor-backed gears + toll income - hedge slippage and fees (R3).
    Backer-minted supply is excluded from the gear value (GearPos.governor_value_usd). Holders are never touched."""
    names = book.underlyings
    ratios = {n: 1.0 for n in names}
    qty = dict(book.hedge_position_usd if start_hedge is None else start_hedge)   # notional at ratio 1
    for n in names:
        qty.setdefault(n, 0.0)
    last_trade = {n: 0.0 for n in names}          # book assumed hedged to its band at the start
    res = PathResult(equity_start=book.equity_usd)
    cum, worst = 0.0, 0.0
    t = 0.0
    by_name: dict[str, float] = {}
    v_start = sum(_gear_value(g, ratios) for g in book.gears)
    for step in path:
        n_sub = 1 if step.dt_s <= 0 else max(1, min(8, math.ceil(step.dt_s / max(hedge.cycle_s, 900))))
        dt = step.dt_s / n_sub
        sub = {k: (1.0 + r) ** (1.0 / n_sub) - 1.0 for k, r in step.returns.items()} if n_sub > 1 else dict(step.returns)
        for _ in range(n_sub):
            v_before = [_gear_value(g, ratios) for g in book.gears]
            old = dict(ratios)
            for k, r in sub.items():
                if k in ratios:
                    ratios[k] = ratios[k] * (1.0 + r)
            v_after = [_gear_value(g, ratios) for g in book.gears]
            step_pnl = 0.0
            for g, vb, va in zip(book.gears, v_before, v_after):
                d = -(va - vb)
                res.gear_pnl += d
                step_pnl += d
                by_name[g.key] = by_name.get(g.key, 0.0) + d
            for n in names:
                h = qty[n] * (ratios[n] - old[n])
                res.hedge_pnl += h
                step_pnl += h
                by_name[n] = by_name.get(n, 0.0) + h
            if dt > 0:
                for g, va in zip(book.gears, v_after):
                    sig = (step.posted_sigma or {}).get(g.key)
                    if sig is None:
                        sig = book.sigma(g.key)[0]
                    rate = g.toll_usd_per_year / max(g.governor_value_usd, 1e-12) if g.toll_usd_per_year is not None else toll_per_year(g.power, sig)
                    inc = va * rate * dt / YEAR_S
                    res.income += inc
                    step_pnl += inc
            t += dt
            if hedge.enabled and step.dt_s > 0:
                step_pnl -= _rehedge(book, hedge, ratios, qty, last_trade, t, step, res)
            cum += step_pnl
            worst = min(worst, cum)
    res.pnl = cum
    res.loss = max(0.0, -worst)
    res.equity_end = book.equity_usd + cum
    res.by_name = by_name
    res.value_change = sum(_gear_value(g, ratios) for g in book.gears) - v_start
    return res


def _rehedge(book: Book, hedge: HedgeModel, ratios: dict, qty: dict, last_trade: dict, t: float, step: Step, res: PathResult) -> float:
    cost = 0.0
    live = [GearPos(g.id, g.key, g.power, g.supply_tokens, g.backer_debt_tokens,
                    _gear_value(g, ratios) / max(g.supply_tokens - g.backer_debt_tokens, 1e-12), g.cap_usd) for g in book.gears]
    target = {k: v[0] for k, v in netting(live).items()}
    ref = hedge.band_ref_usd if hedge.band_ref_usd is not None else book.equity_usd
    for n in book.underlyings:
        notional = qty[n] * ratios[n]
        residual = target.get(n, 0.0) - notional
        go, _reason = hedge.decide(t, last_trade[n], residual, ref, step.venue_up)
        if go:
            qty[n] = target.get(n, 0.0) / ratios[n]
            last_trade[n] = t
            res.rehedges += 1
            cost += hedge.cost(residual, step.slip_mult)
    res.costs += cost
    return cost


def onchain_stress(book: Book, shock_bps: int, max_loss_bps: int = 1500) -> tuple[float, float, dict]:
    """R16: the Governor's own stress rule. Per market the shocks -s, -s/2, +s/2, +s; the market's loss is the worst of the four;
    markets add with no diversification credit; a stale hedge counts zero. Returns (loss, budget, per_market)."""
    s = shock_bps / 1e4
    markets: dict[str, list[GearPos]] = {}
    for g in book.gears:
        markets.setdefault(g.key, []).append(g)
    per: dict[str, float] = {}
    for m, gs in sorted(markets.items()):
        hedge = 0.0 if (book.hedge_stale or "/" in m) else book.hedge_position_usd.get(m, 0.0)
        worst = 0.0
        for x in (-s, -s / 2, s / 2, s):
            d_v = sum(g.governor_value_usd * ((1.0 + x) ** g.power - 1.0) for g in gs)
            worst = max(worst, -(hedge * x - d_v))
        per[m] = worst
    return sum(per.values()), max(book.equity_usd, 0.0) * max_loss_bps / 1e4, per
