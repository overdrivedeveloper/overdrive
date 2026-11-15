"""Parallel mutant runner for the forge suite (hermetic: RHC_RPC_URL is removed from the environment).

Each worker owns a private copy of contracts/ that holds all of src/ and lib/ (symlinked) but only the
test files that exercise the mutated contract: every test/**/*.t.sol that names the contract, directly
or through a test/ file it imports (fork/ and halmos/ are left out), plus their import closure. A
mutant is applied to the worker copy, the selected suites run with a timeout, and the file is restored.

Verdicts: killed (a test failed), survived (all passed), timeout, uncompiled (solc rejected it; not
scored). Baseline: each worker first runs the unmutated selection; a failing baseline aborts.

usage: run.py --contracts DIR --mutants in.jsonl --out results.jsonl --work DIR
              [--jobs 4] [--sample N] [--seed S] [--timeout SEC] [--only id,id] [--contract Name]
"""

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path

IMPORT_RE = re.compile(r'import\s+(?:[^"\']*from\s+)?["\']([^"\']+)["\']')
SKIP_DIRS = ("test/fork/", "test/halmos/")

# Narrow scope: the suites that own each contract (first pass, fast). Survivors are re-run with
# --scope broad, which adds every hermetic test that reaches the contract through any fixture.
NARROW = {
    "ODMinter": ["test/minter/", "test/invariant/SellQueueInvariant.t.sol"],
    "ODBacker": ["test/backer/"],
    "ODGovernor": ["test/governor/"],
    "ODOracleGuard": ["test/oracle/OracleGuard.t.sol", "test/oracle/ReopenRound.t.sol", "test/oracle/HolidayReopen.t.sol"],
    "ODMarketHours": ["test/oracle/MarketHours.t.sol", "test/oracle/Calendar.t.sol", "test/oracle/HolidayReopen.t.sol"],
    "ODHook": ["test/hook/", "test/minter/Hook.t.sol"],
}

# Lighter campaigns than the default profile so each mutant finishes in about a minute. via_ir stays as
# foundry.toml pins it; --no-optimizer turns the optimiser off (same semantics, much faster compile).
ENV_OVERRIDES = {
    "FOUNDRY_FUZZ_RUNS": "64",
    "FOUNDRY_INVARIANT_RUNS": "16",
    "FOUNDRY_INVARIANT_DEPTH": "16",
}


def resolve(root: Path, frm: Path, imp: str):
    if imp.startswith("."):
        p = (frm.parent / imp).resolve()
    else:
        p = (root / imp).resolve()
    try:
        return p.relative_to(root)
    except ValueError:
        return None


def imports_of(root: Path, rel: Path):
    txt = (root / rel).read_text(encoding="utf8", errors="replace")
    out = []
    for imp in IMPORT_RE.findall(txt):
        r = resolve(root, root / rel, imp)
        if r is not None and str(r).split("/")[0] in ("test", "script"):
            out.append(r)
    return out


def select_tests(root: Path, contract: str, scope: str = "broad"):
    files = [p.relative_to(root) for p in (root / "test").rglob("*.sol")]
    files = [f for f in files if not any(str(f).startswith(s) for s in SKIP_DIRS)]
    word = re.compile(r"\b" + re.escape(contract) + r"\b")
    names = {f: bool(word.search((root / f).read_text(encoding="utf8", errors="replace"))) for f in files}
    memo = {}

    def touches(f, stack=()):
        if f in memo:
            return memo[f]
        if f in stack:
            return False
        hit = names.get(f, False)
        if not hit and (root / f).exists():
            for i in imports_of(root, f):
                if touches(i, stack + (f,)):
                    hit = True
                    break
        memo[f] = hit
        return hit

    tests = sorted(f for f in files if str(f).endswith(".t.sol") and touches(f))
    if scope == "narrow" and contract in NARROW:
        tests = [f for f in tests if any(str(f).startswith(p) for p in NARROW[contract])]
    closure, todo = set(), list(tests)
    while todo:
        f = todo.pop()
        if f in closure or not (root / f).exists():
            continue
        closure.add(f)
        todo.extend(imports_of(root, f))
    return tests, sorted(closure)


def make_worker(root: Path, wdir: Path, closure):
    if wdir.exists():
        shutil.rmtree(wdir)
    wdir.mkdir(parents=True)
    shutil.copytree(root / "src", wdir / "src")
    os.symlink(root / "lib", wdir / "lib")
    for n in ("foundry.toml", "remappings.txt"):
        if (root / n).exists():
            shutil.copy2(root / n, wdir / n)
    (wdir / "script").mkdir(exist_ok=True)
    for f in closure:
        dst = wdir / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / f, dst)
    # vectors and deploy configs read through vm.readFile
    for p in list((root / "test").rglob("*.json")) + list((root / "script").rglob("*.json")):
        dst = wdir / p.relative_to(root)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)


def forge_test(wdir: Path, timeout: int):
    env = dict(os.environ)
    env.pop("RHC_RPC_URL", None)
    env.update(ENV_OVERRIDES)
    t0 = time.time()
    try:
        p = subprocess.run(
            # gas-bound tests measure optimised bytecode; with the optimiser off they fail on the clean tree
            ["forge", "test", "--fail-fast", "--no-match-test", "GasBound"],
            cwd=wdir,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "timeout", time.time() - t0, ""
    out = p.stdout + p.stderr
    dt = time.time() - t0
    if p.returncode == 0:
        return "survived", dt, out
    if "Compiler run failed" in out:
        return "uncompiled", dt, out
    return "killed", dt, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contracts", required=True)
    ap.add_argument("--mutants", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--sample", type=int, default=0, help="max mutants per contract (0 = all)")
    ap.add_argument("--seed", type=int, default=1115)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--only", default="")
    ap.add_argument("--cache", default="")
    ap.add_argument("--contract", action="append", default=[])
    ap.add_argument("--scope", choices=["narrow", "broad"], default="narrow")
    ap.add_argument("--no-optimizer", action="store_true", help="FOUNDRY_OPTIMIZER=false (faster compile)")
    a = ap.parse_args()
    if a.no_optimizer:
        ENV_OVERRIDES["FOUNDRY_OPTIMIZER"] = "false"
    root = Path(a.contracts).resolve()
    rows = [json.loads(l) for l in Path(a.mutants).read_text().splitlines() if l.strip()]
    if a.contract:
        rows = [r for r in rows if r["contract"] in a.contract]
    if a.only:
        ids = set(a.only.split(","))
        rows = [r for r in rows if r["id"] in ids]
    by = defaultdict(list)
    for r in rows:
        by[r["contract"]].append(r)
    rng = random.Random(a.seed)
    for c in by:
        if a.sample and len(by[c]) > a.sample:
            by[c] = sorted(rng.sample(by[c], a.sample), key=lambda r: r["id"])
    done = set()
    outp = Path(a.out)
    if outp.exists():
        done = {json.loads(l)["id"] for l in outp.read_text().splitlines() if l.strip()}
    # --cache: verdicts from an earlier run of the same mutants and scope (same file, same tests) are reused
    if a.cache and Path(a.cache).exists():
        cached = {}
        for l in Path(a.cache).read_text().splitlines():
            if l.strip():
                r = json.loads(l)
                cached[r["id"]] = r
        with outp.open("a") as fh:
            for c in by:
                for m in by[c]:
                    if m["id"] in cached and m["id"] not in done:
                        fh.write(json.dumps(cached[m["id"]]) + "\n")
                        done.add(m["id"])
    lock = threading.Lock()
    work = Path(a.work)
    for contract, muts in by.items():
        muts = [m for m in muts if m["id"] not in done]
        if not muts:
            continue
        tests, closure = select_tests(root, contract, a.scope)
        print(f"[{contract}] {len(muts)} mutants, {len(tests)} test files", flush=True)
        workers = [work / f"{contract}-{a.scope}-w{i}" for i in range(min(a.jobs, len(muts)))]
        for w in workers:
            make_worker(root, w, closure)
        # warm one worker, then clone its build so the others start incremental
        v, dt, out = forge_test(workers[0], a.timeout * 3)
        if v != "survived":
            print(f"[{contract}] baseline {v} in {dt:.0f}s\n{out[-3000:]}", file=sys.stderr)
            sys.exit(2)
        print(f"[{contract}] baseline green in {dt:.0f}s", flush=True)
        for w in workers[1:]:
            for d in ("out", "cache"):
                if (workers[0] / d).exists():
                    shutil.copytree(workers[0] / d, w / d, dirs_exist_ok=True)
        queue = list(muts)

        def worker(wdir: Path):
            while True:
                with lock:
                    if not queue:
                        return
                    m = queue.pop(0)
                f = wdir / m["file"]
                orig = f.read_bytes()
                mutated = orig[: m["start"]] + m["new"].encode("utf8") + orig[m["end"] :]
                f.write_bytes(mutated)
                try:
                    v, dt, out = forge_test(wdir, a.timeout)
                finally:
                    f.write_bytes(orig)
                killer = ""
                if v == "killed":
                    hit = re.search(r"\[FAIL[^\]]*\]\s*(\S+)", out)
                    killer = hit.group(1) if hit else ""
                rec = dict(m, verdict=v, seconds=round(dt), killer=killer)
                with lock:
                    with outp.open("a") as fh:
                        fh.write(json.dumps(rec) + "\n")
                    print(f"  {m['id']} {contract} L{m['line']} {m['op']}: {v} ({dt:.0f}s)", flush=True)

        ts = [threading.Thread(target=worker, args=(w,)) for w in workers]
        for t in ts:
            t.start()
        for t in ts:
            t.join()


if __name__ == "__main__":
    main()
