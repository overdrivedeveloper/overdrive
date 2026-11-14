from pathlib import Path

from risk_sim.book import load_fixture
from risk_sim.cli import evaluate, main
from risk_sim.config import Settings
from risk_sim.report import build_report, dumps

FIX = Path(__file__).parent / "fixtures" / "book_small.json"


def test_reproducible_bytes(tmp_path, monkeypatch):
    for k in ("DATABASE_URL", "TELEGRAM_OUTBOX"):
        monkeypatch.delenv(k, raising=False)
    outs = []
    for i in range(2):
        assert main(["run", "--scenario", "vol_spike_2x", "--from-fixture", str(FIX), "--out-dir", str(tmp_path / str(i)), "--date", "2026-11-13"]) == 0
        outs.append((tmp_path / str(i) / "2026-11-13" / "report.json").read_bytes())
    assert outs[0] == outs[1] and len(outs[0]) > 500
    s = Settings()
    book = load_fixture(FIX)
    docs = []
    for _ in range(2):
        results, onchain, gate, plan = evaluate(book, s, ["single_stock_minus_18_7"], False)
        docs.append(dumps(build_report("d", book, results, gate, plan, onchain, s, [], [])))
    assert docs[0] == docs[1]
