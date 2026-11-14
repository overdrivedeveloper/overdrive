"""Invariant: whatever the prices and the prior post, a planned value is inside the step bound and the oracle's bounds."""

import numpy as np

from vol_engine.config import Settings
from vol_engine.engine import plan_pass
from vol_engine.guard import ChainState, contract_rejects
from vol_engine.history import History
from vol_engine.store import MemoryStore

from helpers import ANVIL_KEY, ORACLE, FakeOracle, crypto_ticks

T0 = 1_760_000_000.0
N = 12 * 288


def test_planned_values_always_in_bounds():
    rng = np.random.default_rng(2026)
    s = Settings(signer_key=ANVIL_KEY, oracle_address=ORACLE, chain_id=31337, keys=("ETH",))
    for i in range(200):
        vol = float(rng.uniform(0.05, 2.5))
        ticks = crypto_ticks(T0, N, vol, seed=i)
        if i % 3 == 0:
            ticks = crypto_ticks(T0, N, vol, seed=i, shock_at=N - 5, shock=float(rng.uniform(-0.3, 0.3)))
        st = MemoryStore()
        st.tick_rows["ETH"] = ticks
        now = ticks[-1].ts + 60
        floor = int(rng.integers(500, 4000))
        ceiling = int(rng.integers(floor + 200, 30_001))
        oracle = FakeOracle(floor, ceiling)
        prior = int(rng.integers(100, 40_000)) if i % 5 else 0
        from vol_engine.markets import resolve
        mk = resolve("ETH")
        if prior:
            oracle.states[mk.hex] = ChainState(prior, int(now) - 1000, int(now) + 100, int(rng.integers(0, 50)))
        out = plan_pass(now, s, st, History(), oracle, force=True)
        assert len(out) == 1
        it, state = out[0], oracle.state(mk.hex)
        assert contract_rejects(sigma_bps=it.sigma_bps, buy_from=it.buy_block_from, buy_to=it.buy_block_to,
                                valid_until=it.valid_until, nonce=it.nonce, now=int(now), state=state,
                                floor_bps=floor, ceiling_bps=ceiling) is None, (i, it.sigma_bps, prior, floor, ceiling)
        assert floor <= it.sigma_bps <= ceiling
        if prior:
            ref = min(max(prior, floor), ceiling)
            assert abs(it.sigma_bps - ref) * 10_000 <= ref * 2_500
