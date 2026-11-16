"""Generate mutants with the slither-mutate mutators, without running any test.

Runs under the slither-analyzer Python (it imports slither). Reads the existing forge build-info
(no recompile), asks every slither-mutate mutator for its patches on each target contract and writes
them as JSON lines: {id, contract, file, start, end, old, new, line, op}.

usage: gen.py <contracts_dir> <out.jsonl> <ContractName> [<ContractName> ...]
"""

import json
import sys
from pathlib import Path

from slither import Slither
from slither.tools.mutator.mutators import all_mutators
from slither.tools.mutator.mutators.abstract_mutator import AbstractMutator


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2])
    names = sys.argv[3:]
    sl = Slither(str(root), foundry_ignore_compile=True)
    mutators = [
        m
        for m in vars(all_mutators).values()
        if isinstance(m, type) and issubclass(m, AbstractMutator) and m is not AbstractMutator
    ]
    seen = set()
    rows = []
    for name in names:
        found = None
        for cu in sl.compilation_units:
            for c in cu.contracts:
                if c.name == name and str(root / "src") in c.source_mapping.filename.absolute:
                    found = (cu, c)
                    break
            if found:
                break
        if not found:
            print(f"gen: contract {name} not found", file=sys.stderr)
            sys.exit(1)
        cu, contract = found
        for M in mutators:
            m = M(cu, 0, "true", "test", contract, None, False, Path("/dev/null"), [])
            try:
                res = m._mutate()  # pylint: disable=protected-access
            except Exception as e:  # pylint: disable=broad-except
                print(f"gen: {M.NAME} failed on {name}: {e}", file=sys.stderr)
                continue
            for file, patches in res.get("patches", {}).items():
                rel = str(Path(file).resolve().relative_to(root))
                src = (root / rel).read_bytes()
                for p in patches:
                    p = dict(p)
                    span = src[p["start"] : p["end"]].decode("utf8", "replace")
                    full = p["old_string"]
                    if full != span:
                        # Some mutators (ROR, AOR) patch the expression span but build the replacement from
                        # the whole statement text. Cut the replacement back to the span when the statement
                        # starts with it; otherwise the mutant cannot be placed and is dropped.
                        idx = full.find(span)
                        if idx < 0 or not p["new_string"].startswith(full[:idx]):
                            continue
                        tail = full[idx + len(span) :]
                        nn = p["new_string"][idx:]
                        if tail and not nn.endswith(tail):
                            continue
                        p["new_string"] = nn[: len(nn) - len(tail)] if tail else nn
                    key = (rel, p["start"], p["end"], p["new_string"])
                    if key in seen:
                        continue
                    seen.add(key)
                    rows.append(
                        {
                            "contract": name,
                            "file": rel,
                            "start": p["start"],
                            "end": p["end"],
                            "old": src[p["start"] : p["end"]].decode("utf8", "replace"),
                            "new": p["new_string"],
                            "line": p["line_number"],
                            "op": M.NAME,
                        }
                    )
    rows.sort(key=lambda r: (r["contract"], r["file"], r["start"], r["op"], r["new"]))
    with out.open("w", encoding="utf8") as f:
        for i, r in enumerate(rows):
            r["id"] = f"m{i:04d}"
            f.write(json.dumps(r) + "\n")
    print(f"gen: {len(rows)} mutants")


if __name__ == "__main__":
    main()
