#!/usr/bin/env python3
"""Rule R5 (todo 11): list every external/public state-changing function in contracts/src guarded by a role, owner or
caller check, with the guard. Usage: privileged-functions.py [--check]   (run from contracts/)
--check exits 1 when contracts/privileged-functions.json differs from the sources (CI step check_privileged_functions)."""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
OUT = ROOT / "privileged-functions.json"
HEAD = re.compile(r"\bfunction\s+(\w+)\s*\(")
GUARDS = [
    (re.compile(r"onlyRole\(\s*([\w.]+)\s*\)"), lambda m: m.group(1)),
    (re.compile(r"_checkRole\(\s*([\w.]+)\s*\)"), lambda m: m.group(1)),
    (re.compile(r"hasRole\(\s*([\w.]+)\s*,\s*msg\.sender\s*\)"), lambda m: m.group(1)),
    (re.compile(r"\bonlyOwner\b|_checkOwner\(\)|owner\(\)"), lambda m: "owner"),
    (re.compile(r"msg\.sender\s*!=\s*guardian\b"), lambda m: "guardian"),
    (re.compile(r"\bonly(Minter|Backer|PoolManager|Governor|Fees|EntryPoint)\b"), lambda m: "only" + m.group(1)),
]


def norm(role: str) -> str:
    return role.split(".")[-1]


def functions(text: str):
    """Returns (name, header, body) for each function with a body."""
    found = []
    for m in HEAD.finditer(text):
        i = m.end()
        depth = 1
        while depth and i < len(text):  # end of the parameter list
            depth += {"(": 1, ")": -1}.get(text[i], 0)
            i += 1
        j = i
        while j < len(text) and text[j] not in "{;":
            j += 1
        if j >= len(text) or text[j] == ";":
            continue
        header = text[m.start():j]
        k, depth = j + 1, 1
        while depth and k < len(text):
            depth += {"{": 1, "}": -1}.get(text[k], 0)
            k += 1
        found.append((m.group(1), header, text[j:k]))
    return found


def scan() -> dict:
    out = {}
    for path in sorted(SRC.rglob("*.sol")):
        if "interfaces" in path.parts:
            continue
        text = re.sub(r"//[^\n]*", "", path.read_text())
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        rows = []
        for name, header, body in functions(text):
            if not re.search(r"\b(external|public)\b", header) or re.search(r"\b(view|pure)\b", header):
                continue
            access = set()
            for rx, f in GUARDS:
                for m in rx.finditer(header + body):
                    access.add(norm(f(m)))
            if access:
                rows.append({"function": name, "access": sorted(access)})
        if rows:
            out[f"{path.relative_to(ROOT)}"] = sorted(rows, key=lambda r: r["function"])
    return out


def main() -> int:
    text = json.dumps(scan(), indent=1, sort_keys=True) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print("privileged-functions.json differs from the sources: run script/ci/privileged-functions.py", file=sys.stderr)
            return 1
        print("privileged-functions.json matches the sources")
        return 0
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
