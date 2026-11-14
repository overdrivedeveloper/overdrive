"""R14: every dependency is an exact pin with hashes; nothing imports the vol-engine at runtime; the floors file equals the vol-engine's."""

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_all_pinned():
    data = tomllib.loads((ROOT / "pyproject.toml").read_text())
    specs = data["project"]["dependencies"] + data["project"]["optional-dependencies"]["dev"] + data["build-system"]["requires"]
    for spec in specs:
        assert re.search(r"==\s*[0-9]", spec), f"not an exact pin: {spec}"
        assert not re.search(r"[<>~^]|!=", spec.split(";")[0]), f"range in {spec}"
    for name in ("requirements.lock", "requirements-dev.lock"):
        blocks = re.split(r"(?m)^(?=[A-Za-z0-9_.\-]+==)", (ROOT / name).read_text())[1:]
        assert blocks, name
        for block in blocks:
            assert "--hash=sha256:" in block, f"{name}: no hash for {block.splitlines()[0]}"
    runtime = (ROOT / "requirements.lock").read_text()
    for pkg in ("numpy", "psycopg", "setuptools"):
        assert re.search(rf"(?m)^{pkg}==", runtime), pkg
    for line in (ROOT / "requirements.in").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            assert "==" in line, f"unpinned requirements.in line: {line}"


def test_no_vol_engine_import_and_floors_agree():
    for p in (ROOT / "src" / "risk_sim").glob("*.py"):
        assert "vol_engine" not in p.read_text(), p.name
    import json

    floors = json.loads((ROOT / "data" / "floors.json").read_text())
    cfg = (ROOT.parent / "vol-engine" / "src" / "vol_engine" / "config.py")
    if cfg.exists():
        text = cfg.read_text()
        want = {"crypto": "FLOOR_CRYPTO", "index_etf": "FLOOR_INDEX_ETF", "mega": "FLOOR_MEGA", "retail": "FLOOR_RETAIL", "pair": "FLOOR_PAIR"}
        for k, const in want.items():
            assert float(re.search(rf"^{const}\s*=\s*([0-9.]+)", text, re.M).group(1)) == floors[k], k
