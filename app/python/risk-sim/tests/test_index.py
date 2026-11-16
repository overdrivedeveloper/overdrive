import json
import random
from decimal import Decimal, getcontext
from pathlib import Path

import pytest

from risk_sim.index import POWERS, gear_value, in_domain

getcontext().prec = 50
VEC = Path(__file__).parent / "fixtures" / "index_vectors.json"


def test_matches_reference_and_vectors():
    rng = random.Random(7)
    for p in (1.5, 2.0, 3.0, 0.5, -1.0, -0.5, 2.5):
        for _ in range(1000):
            ratio = rng.uniform(0.05, 20.0)
            nf = rng.uniform(0.5, 1.2)
            ref = Decimal(nf) * Decimal(ratio) ** Decimal(p) * Decimal(100)
            got = gear_value(p, ratio, nf, 100.0)
            assert abs(Decimal(got) - ref) <= Decimal("1e-12") * abs(ref)
    if not VEC.exists():
        pytest.skip("contracts/test/vectors/index-vectors.json not present: vector comparison pending")
    cases = [c for c in json.loads(VEC.read_text())["cases"] if c["inDomain"]]
    assert len(cases) > 100
    for c in cases:
        ratio = int(c["p"]) / int(c["p0"])
        want = int(c["value"]) / 1e18
        got = gear_value(POWERS[c["gear"]], ratio, int(c["nf"]) / 1e18, int(c["unit"]) / 1e18)
        assert got == pytest.approx(want, rel=1e-12, abs=2e-18)


def test_domain():
    assert in_domain(1.0) and not in_domain(0.01) and not in_domain(60.0)
