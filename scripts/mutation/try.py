"""Run chosen test files in a private narrow copy of contracts/ (optimiser off), optionally with one mutant
applied: try.py <work_dir> <mutants.jsonl|-> <mutant_id|-> <test file> [<test file> ...]"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import run  # noqa: E402

root = Path(__file__).resolve().parents[2] / "contracts"
w, mfile, mid, tests = Path(sys.argv[1]), sys.argv[2], sys.argv[3], [Path(t) for t in sys.argv[4:]]
closure, todo = set(), list(tests)
while todo:
    f = todo.pop()
    if f in closure or not (root / f).exists():
        continue
    closure.add(f)
    todo.extend(run.imports_of(root, f))
if not w.exists():
    run.make_worker(root, w, sorted(closure))
else:
    for f in closure:
        (w / f).parent.mkdir(parents=True, exist_ok=True)
        (w / f).write_bytes((root / f).read_bytes())
run.ENV_OVERRIDES["FOUNDRY_OPTIMIZER"] = "false"
orig = None
if mid != "-":
    m = next(r for r in map(json.loads, open(mfile)) if r["id"] == mid)
    f = w / m["file"]
    orig = f.read_bytes()
    f.write_bytes(orig[: m["start"]] + m["new"].encode() + orig[m["end"]:])
try:
    v, dt, out = run.forge_test(w, 1800)
finally:
    if orig is not None:
        f.write_bytes(orig)
print(mid, v, round(dt))
print("\n".join(l for l in out.splitlines() if "FAIL" in l or "Suite result" in l or "Error" in l or "Ran " in l)[-3000:])
