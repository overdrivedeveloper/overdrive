#!/usr/bin/env python3
"""Fetch the public candles risk-sim replays (free sources, no key). Same as `risk-sim fetch-history`."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from risk_sim.history import fetch_all  # noqa: E402

print(json.dumps(fetch_all()))
