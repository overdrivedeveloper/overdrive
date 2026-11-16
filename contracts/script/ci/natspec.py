#!/usr/bin/env python3
"""NatSpec check: every public or external function in contracts/src
carries a NatSpec comment (/// or /** */, @inheritdoc counts) directly above it.

Usage: python3 script/ci/natspec.py [--check] [--self-test] [src_dir]
  prints each gap as file:line name; with --check exits 1 if any gap is found.
  --self-test proves the scanner flags an undocumented external function and passes a documented one.
"""
import os
import re
import sys

FUNC = re.compile(r"^\s*function\s+(\w+)\s*\(")
VIS = re.compile(r"\b(external|public)\b")


def signature(lines, i):
    """Join the function header from line i up to its body or semicolon."""
    out = []
    for j in range(i, min(i + 40, len(lines))):
        out.append(lines[j])
        if "{" in lines[j] or ";" in lines[j]:
            break
    return " ".join(out)


def has_natspec(lines, i):
    j = i - 1
    while j >= 0 and lines[j].strip() == "":
        j -= 1
    while j >= 0 and lines[j].strip().startswith("//") and not lines[j].strip().startswith("///"):
        j -= 1  # plain // comments (lint or slither markers) may sit between the NatSpec and the function
    if j < 0:
        return False
    s = lines[j].strip()
    return s.startswith("///") or s.endswith("*/")


def scan(src):
    gaps = []
    for root, _, files in os.walk(src):
        for name in sorted(files):
            if not name.endswith(".sol"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().split("\n")
            for i, line in enumerate(lines):
                m = FUNC.match(line)
                if not m:
                    continue
                head = signature(lines, i)
                if not VIS.search(head):
                    continue
                if not has_natspec(lines, i):
                    gaps.append(f"{path}:{i + 1} {m.group(1)}")
    return gaps


def self_test():
    import tempfile
    bad = "contract A {\n    // a plain comment is not NatSpec\n    function f(\n        uint256 x\n    ) external {}\n}\n"
    good = "contract B {\n    /// @notice ok\n    // slither-disable-next-line x\n    function g() public {}\n    function h() internal {}\n}\n"
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "A.sol"), "w").write(bad)
        open(os.path.join(d, "B.sol"), "w").write(good)
        gaps = scan(d)
    ok = len(gaps) == 1 and gaps[0].endswith("A.sol:3 f")
    print("natspec self-test " + ("ok" if ok else "FAILED: %r" % gaps), file=sys.stderr)
    return 0 if ok else 1


def main(argv):
    if "--self-test" in argv:
        return self_test()
    check = "--check" in argv
    rest = [a for a in argv if a != "--check"]
    src = rest[0] if rest else "src"
    gaps = scan(src)
    for g in gaps:
        print(g)
    print(f"natspec: {len(gaps)} public or external function(s) without NatSpec under {src}", file=sys.stderr)
    return 1 if (check and gaps) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
