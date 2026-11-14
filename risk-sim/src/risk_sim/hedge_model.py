"""The real hedger policy (todo 16 bands.ts), not a perfect hedge: it acts only at its cycle, only on a band, hard band or the
interval, only when a venue is up, and pays slippage and fees on every fill. Target = net delta (gamma is never traded)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class HedgeModel:
    lag_s: int = 1800                  # RISK_HEDGE_LAG_SECONDS = the hedger interval: a trade at least this often if any residual
    band_bps: int = 50                 # of equity (or of band_ref_usd)
    hard_band_bps: int = 200
    cycle_s: int = 60
    cooldown_s: int = 120
    min_trade_usd: float = 25.0
    slippage_bps: float = 10.0
    fee_bps: float = 2.0
    enabled: bool = True               # False: never trades (the "no venue" and "unhedged" variants)
    band_ref_usd: float | None = None  # None: the book's equity

    def decide(self, now_s: float, last_trade_s: float, residual: float, ref_usd: float, venue_up: bool) -> tuple[bool, str]:
        """(trade, reason) for one underlying. Mirrors decideRehedge: band, hard band, interval; never inside the cooldown."""
        if not self.enabled or not venue_up:
            return False, "no_venue"
        size = abs(residual)
        if size == 0 or size < self.min_trade_usd:
            return False, "below_min_size"
        if now_s - last_trade_s < self.cooldown_s:
            return False, "cooldown"
        if ref_usd <= 0:
            return False, "no_equity"
        if size > ref_usd * self.hard_band_bps / 1e4:
            return True, "hard_band"
        if size > ref_usd * self.band_bps / 1e4:
            return True, "band"
        if now_s - last_trade_s >= self.lag_s:
            return True, "interval"
        return False, "within_band"

    def cost(self, trade_usd: float, slip_mult: float = 1.0) -> float:
        return abs(trade_usd) * (self.slippage_bps * slip_mult + self.fee_bps) / 1e4

    def off(self) -> "HedgeModel":
        return HedgeModel(**{**self.__dict__, "enabled": False})

    @staticmethod
    def from_settings(s) -> "HedgeModel":
        return HedgeModel(lag_s=s.hedge_lag_s, band_bps=s.hedge_band_bps, hard_band_bps=s.hedge_hard_band_bps, cycle_s=s.hedge_cycle_s,
                          cooldown_s=s.hedge_cooldown_s, min_trade_usd=s.hedge_min_trade_usd, slippage_bps=s.hedge_slippage_bps,
                          fee_bps=s.hedge_fee_bps)
