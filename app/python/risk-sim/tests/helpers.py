from __future__ import annotations

from risk_sim.book import Book, GearPos


def mk(gears, equity=400_000.0, sigma=None, hedge=None, **kw) -> Book:
    """gears: [(key, power, value_usd)]"""
    gs = tuple(GearPos(f"{k}:{p}", k, p, v, 0.0, 1.0, 1_000_000.0) for k, p, v in gears)
    from risk_sim.governor import netting

    pos = {u: d for u, (d, _g) in netting(gs).items()} if hedge is None else hedge
    return Book(gears=gs, equity_usd=equity, hedge_position_usd=pos, sigma_bps=sigma or {g.key: 6000.0 for g in gs},
                exit_reserve_usd=kw.pop("reserve", 1e9), as_of="2026-11-13T02:00:00Z", book_ts="2026-11-13T01:55:00Z",
                price_ts="2026-11-13T01:58:00Z", **kw)


HEDGER_BOOK = [("X", 2.0, 100_000.0), ("X", 0.5, 100_000.0), ("X", -1.0, 50_000.0)]   # Sport, Eco, Reverse (todo 16 R1)
