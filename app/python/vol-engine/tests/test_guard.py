import random

from vol_engine.guard import ChainState, clamp_step, contract_rejects, step_bounds


def test_step_and_bounds():
    # prior 3,000 bps, target 6,000: the first post is 3,750 and ramped
    v, flags = clamp_step(6000, 3000, 500, 30000)
    assert v == 3750 and flags == ["ramped"]
    # a first post is exempt from the step
    assert clamp_step(6000, None, 500, 30000) == (6000, [])
    # outside bounds(market): clamped into them
    assert clamp_step(9000, None, 3000, 8000) == (8000, ["clamped"])
    assert clamp_step(1000, None, 3000, 8000) == (3000, ["clamped"])
    # downward step is 25% too
    assert clamp_step(1000, 4000, 500, 30000) == (3000, ["ramped"])
    # a prior outside the bounds is taken at its clamp, as the contract does
    assert step_bounds(2000, 3000, 8000) == (3000, 3750)
    assert step_bounds(20000, 3000, 8000) == (6000, 8000)


def test_python_port_rejects_what_the_contract_rejects():
    st = ChainState(sigma_bps=3000, posted_at=1_000_000, valid_until=1_003_600, nonce=4)
    ok = dict(sigma_bps=3750, buy_from=0, buy_to=0, valid_until=1_003_700, nonce=5, now=1_000_100, state=st,
              floor_bps=500, ceiling_bps=30000)
    assert contract_rejects(**ok) is None
    assert contract_rejects(**{**ok, "sigma_bps": 3751}) == "StepTooLarge"
    assert contract_rejects(**{**ok, "nonce": 4}) == "NonceUsed"
    assert contract_rejects(**{**ok, "now": 1_000_020}) == "TooSoon"
    assert contract_rejects(**{**ok, "valid_until": 1_000_200}) == "Expired"
    assert contract_rejects(**{**ok, "valid_until": 1_000_100 + 7201}) == "Expired"
    assert contract_rejects(**{**ok, "sigma_bps": 400}) == "OutOfBounds"
    assert contract_rejects(**{**ok, "buy_from": 1_000_000, "buy_to": 1_000_500}) == "BadBuyBlockWindow"
    assert contract_rejects(**{**ok, "buy_from": 1_000_100, "buy_to": 1_000_100 + 3 * 86400 + 1}) == "BadBuyBlockWindow"


def test_random_targets_never_rejected():
    rng = random.Random(5)
    for _ in range(500):
        floor = rng.randint(500, 4000)
        ceil = rng.randint(floor + 100, 30000)
        prior = rng.randint(100, 40000)
        target = rng.randint(0, 50000)
        v, _ = clamp_step(target, prior, floor, ceil)
        st = ChainState(prior, 1, 10**9, 1)
        assert contract_rejects(sigma_bps=v, buy_from=0, buy_to=0, valid_until=1000 + 3600, nonce=2, now=1000 + 100,
                                state=st, floor_bps=floor, ceiling_bps=ceil) is None
