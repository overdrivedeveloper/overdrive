#!/usr/bin/env python3
"""Test shards for the public CI (the `contracts-tests` matrix in .github/workflows/ci.yml).

One via-ir build of every contract and every test needs more memory than a free hosted runner has (16 GB). Each shard
compiles only its own test directories plus what they import, with the unchanged foundry.toml (via_ir, the same
optimizer), so the contracts under test are built exactly as deployed and every suite still runs, in exactly one shard.
A shard is a list of directories under test/. The local gate (.github/scripts/ci-local.sh) runs every suite in one
`forge test` and does not use this file.

Usage (from contracts/): python3 script/ci/test-shards.py --check | --list | --glob SHARD
  --check        exit 1 unless every Solidity file under test/ is in exactly one shard (or one helper directory that
                 holds no test) and the workflow matrix names exactly these shards
  --list         shard names, one per line
  --glob SHARD   the shard's glob, for `forge test --match-path "$(...)"`
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT.parent / ".github" / "workflows" / "ci.yml"

# Balanced on measured peak compiler memory (cold build), not on file count: see the table in ci.yml.
SHARDS: dict[str, list[str]] = {
    "governor": ["governor", "gear", "fees", "stake"],
    "poc": ["poc", "scaffold", "halmos"],
    "backer": ["backer", "minter", "periphery"],
    "oracle": ["oracle", "math", "hook", "agent"],
    "system": ["system", "fork"],
    "invariant": ["invariant", "audit"],
}
# Imported by the suites; they hold no test of their own (checked below).
HELPERS = ["mocks", "utils", "fixtures", "vectors"]
TEST_FUNCTION = re.compile(r"\bfunction\s+(test|invariant|statefulFuzz|check_|prove)")


def check() -> int:
    problems: list[str] = []
    owners: dict[str, list[str]] = {}
    for shard, dirs in SHARDS.items():
        if not dirs:
            problems.append(f"shard {shard} has no directory")
        for d in dirs:
            owners.setdefault(d, []).append(shard)
            if not (ROOT / "test" / d).is_dir():
                problems.append(f"shard {shard}: test/{d} is not a directory")
    for d, shards in sorted(owners.items()):
        if len(shards) > 1:
            problems.append(f"test/{d} is in {len(shards)} shards: {', '.join(shards)}")
        if d in HELPERS:
            problems.append(f"test/{d} is both a helper directory and in shard {shards[0]}")
    suites = 0
    for sol in sorted((ROOT / "test").rglob("*.sol")):
        rel = sol.relative_to(ROOT / "test")
        top = rel.parts[0]
        if len(rel.parts) == 1:
            problems.append(f"test/{rel} is not inside a directory, so no shard runs it")
        elif top in HELPERS:
            if sol.name.endswith(".t.sol") or TEST_FUNCTION.search(sol.read_text()):
                problems.append(f"test/{rel} holds a test but test/{top} is a helper directory, so no shard runs it")
        elif top not in owners:
            problems.append(f"test/{rel} is in no shard (add test/{top} to a shard in script/ci/test-shards.py)")
        elif sol.name.endswith(".t.sol"):
            suites += 1
    match = re.search(r"^\s*shard:\s*\[([^\]]*)\]", WORKFLOW.read_text(), re.M) if WORKFLOW.is_file() else None
    if match is None:
        problems.append(f"{WORKFLOW.name}: no `shard: [...]` matrix found")
    else:
        matrix = [name.strip() for name in match.group(1).split(",") if name.strip()]
        if sorted(matrix) != sorted(SHARDS) or len(matrix) != len(set(matrix)):
            problems.append(f"{WORKFLOW.name} matrix {matrix} differs from the shards {list(SHARDS)}")
    for problem in problems:
        print(f"FAIL test-shards: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"test-shards: {suites} test files, each in exactly one of {len(SHARDS)} shards")
    return 0


def main() -> int:
    args = sys.argv[1:]
    if args == ["--check"]:
        return check()
    if args == ["--list"]:
        print("\n".join(SHARDS))
        return 0
    if len(args) == 2 and args[0] == "--glob" and args[1] in SHARDS:
        print("test/{" + ",".join(SHARDS[args[1]]) + "}/**")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
