"""Past report moves and weekend gaps (conservative defaults apply when these are short).

vol-moves.json:   {"NVDA": [0.051, -0.07, ...]}   1-day moves after past reports, oldest first
vol-weekend.json: {"NVDA": [0.012, ...]}          |Friday close to Monday open| moves, one per week
earnings-overrides.json: {"NVDA": [{"date": "2026-11-19", "session": "post"}]}   dates the company itself published
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .earnings import SOURCE_B, EarningsRow


def _load(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    return {k.upper(): v for k, v in raw.items() if not k.startswith("_")}


@dataclass
class History:
    moves: dict[str, list[float]] = field(default_factory=dict)
    weekend: dict[str, list[float]] = field(default_factory=dict)
    overrides: list[EarningsRow] = field(default_factory=list)   # the company_ir source

    @staticmethod
    def from_dir(config_dir: str = "") -> "History":
        base = Path(config_dir) if config_dir else Path(__file__).resolve().parents[3] / "app" / "src" / "config"
        moves = {k: [float(x) for x in v] for k, v in _load(base / "vol-moves.json").items()}
        weekend = {k: [float(x) for x in v] for k, v in _load(base / "vol-weekend.json").items()}
        rows = [EarningsRow(sym, date.fromisoformat(e["date"]), e.get("session", "unknown"), SOURCE_B)
                for sym, entries in _load(base / "earnings-overrides.json").items() for e in entries]
        return History(moves, weekend, rows)
