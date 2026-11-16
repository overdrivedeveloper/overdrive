from __future__ import annotations

from datetime import date, datetime, time, timedelta

import numpy as np

from vol_engine.bars import ET, Tick

ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # // test-key
ANVIL_KEY_2 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # // test-key
ORACLE = "0x00000000000000000000000000000000000F0D01"
CHAIN_ID = 31337


def et_ts(d: date, hh: int, mm: int) -> float:
    return datetime.combine(d, time(hh, mm), tzinfo=ET).timestamp()


def weekdays(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def equity_ticks(days: list[date], seed: int = 1, bar_vol: float = 0.0006, gap_vol: float = 0.004, start_px: float = 100.0,
                 extended: bool = False, rets: np.ndarray | None = None) -> list[Tick]:
    """78 regular 5-minute ticks per day (from `rets` when given, else seeded normal returns)."""
    rng = np.random.default_rng(seed)
    ticks: list[Tick] = []
    px = start_px
    for n, d in enumerate(days):
        px *= float(np.exp(rng.normal(0, gap_vol)))
        t0 = et_ts(d, 9, 30)
        for i in range(78):
            if i > 0:
                px *= float(np.exp(rets[n * 78 + i] if rets is not None else rng.normal(0, bar_vol)))
            ticks.append(Tick(t0 + 300 * i + 1, px, "REGULAR", True))
        if extended:
            for hh, mm in ((8, 0), (17, 0)):
                ticks.append(Tick(et_ts(d, hh, mm), px * 1.05, "EXTENDED", True))
    return ticks


def crypto_ticks(start_ts: float, n_bars: int, annual_vol: float, seed: int = 1, start_px: float = 100.0, shock_at: int = -1,
                 shock: float = 0.0, normals: np.ndarray | None = None) -> list[Tick]:
    """One tick per 5 minutes, geometric Brownian motion with `annual_vol` on a 365-day year."""
    rng = np.random.default_rng(seed)
    bar_vol = annual_vol / np.sqrt(288 * 365)
    z = normals if normals is not None else rng.normal(0, 1, n_bars)
    px, out = start_px, []
    for i in range(n_bars):
        px *= float(np.exp(bar_vol * z[i] - 0.5 * bar_vol**2 + (shock if i == shock_at else 0.0)))
        out.append(Tick(start_ts + 300 * i, px, "REGULAR", True))
    return out


class FakeOracle:
    """Stands in for ODVolOracle reads: per-market state and bounds, with the contract's accept rules in `accept`."""

    def __init__(self, floor: int = 500, ceiling: int = 30_000) -> None:
        from vol_engine.guard import ChainState
        self._cs = ChainState
        self.states: dict[str, object] = {}
        self.floor, self.ceiling = floor, ceiling
        self.bound_map: dict[str, tuple[int, int]] = {}

    def state(self, market_hex):
        return self.states.get(market_hex, self._cs())

    def bounds(self, market_hex, now_s):
        return self.bound_map.get(market_hex, (self.floor, self.ceiling))

    def accept(self, intent, now: int) -> None:
        """Apply an intent the way the contract would, asserting the contract would not have rejected it."""
        from vol_engine.guard import contract_rejects
        fl, ce = self.bounds(intent.market, now)
        why = contract_rejects(sigma_bps=intent.sigma_bps, buy_from=intent.buy_block_from, buy_to=intent.buy_block_to,
                               valid_until=intent.valid_until, nonce=intent.nonce, now=now, state=self.state(intent.market),
                               floor_bps=fl, ceiling_bps=ce)
        assert why is None, why
        self.states[intent.market] = self._cs(intent.sigma_bps, now, intent.valid_until, intent.nonce,
                                              intent.buy_block_from, intent.buy_block_to)
