import json

from vol_engine.history import History


def test_default_config_dir_loads_the_shipped_files():
    h = History.from_dir()
    assert h.moves == {} and h.weekend == {} and h.overrides == []   # the shipped seeds are empty until filled


def test_files_load_with_upper_cased_names(tmp_path):
    (tmp_path / "vol-moves.json").write_text(json.dumps({"nvda": [0.05, -0.06]}))
    (tmp_path / "vol-weekend.json").write_text(json.dumps({"SPY": [0.01]}))
    (tmp_path / "earnings-overrides.json").write_text(json.dumps({"_comment": "x", "NVDA": [{"date": "2026-11-19", "session": "post"}]}))
    h = History.from_dir(str(tmp_path))
    assert h.moves == {"NVDA": [0.05, -0.06]} and h.weekend == {"SPY": [0.01]}
    assert h.overrides[0].symbol == "NVDA" and h.overrides[0].source == "company_ir" and h.overrides[0].session == "post"
