"""R15: every dependency is an exact pin, and the lock carries hashes for all of them."""

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
        text = (ROOT / name).read_text()
        blocks = re.split(r"(?m)^(?=[A-Za-z0-9_.\-]+==)", text)[1:]
        assert blocks, name
        for block in blocks:
            assert "--hash=sha256:" in block, f"{name}: no hash for {block.splitlines()[0]}"
    runtime = (ROOT / "requirements.lock").read_text()
    for pkg in ("numpy", "eth-account", "psycopg", "tzdata", "setuptools"):
        assert re.search(rf"(?m)^{pkg}==", runtime), pkg
    for line in (ROOT / "requirements.in").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            assert "==" in line, f"unpinned requirements.in line: {line}"
