from risk_sim.hedge_model import HedgeModel
from risk_sim.governor import simulate
from risk_sim.paths import Step, gap
from helpers import HEDGER_BOOK, mk

H = HedgeModel()


def test_lag_band_and_outage_respected():
    ref = 400_000.0                       # band 50 bps = 2,000 USD, hard band 200 bps = 8,000 USD
    assert H.decide(200, 0, 1_000, ref, True) == (False, "within_band")
    assert H.decide(200, 0, 3_000, ref, True) == (True, "band")
    assert H.decide(200, 0, 9_000, ref, True) == (True, "hard_band")
    assert H.decide(1900, 0, 1_000, ref, True) == (True, "interval")          # only at the hedger's interval
    assert H.decide(200, 0, 9_000, ref, False) == (False, "no_venue")         # nothing inside an outage
    assert H.decide(60, 0, 9_000, ref, True) == (False, "cooldown")
    assert H.decide(1900, 0, 10.0, ref, True) == (False, "below_min_size")
    # end to end: a hedge that is off by 10k notional is not repaired during an outage and is repaired once the venue is up
    book = mk(HEDGER_BOOK, hedge={"X": 190_000.0})
    down = simulate(book, [Step(3600.0, {}, venue_up=False)], H)
    up = simulate(book, [Step(3600.0, {}, venue_up=True)], H)
    assert down.rehedges == 0 and up.rehedges >= 1 and up.costs > 0
    # no trade between ticks of a small move: a gap alone never rehedges
    assert simulate(book, gap({"X": 0.05}), H).rehedges == 0
