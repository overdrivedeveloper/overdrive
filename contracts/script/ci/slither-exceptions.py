#!/usr/bin/env python3
"""Inline slither exceptions: every `slither-disable` comment under contracts/src must have a row (file,
function, detector) in the "Inline exceptions in deployable source" table of SLITHER.md, and every row must
match a disable that exists. Usage: python3 script/ci/slither-exceptions.py [--check]"""
import os
import re
import sys

DISABLE = re.compile(r"slither-disable(?:-next-line|-line|-start)?\s+([\w,-]+)")
FUNC = re.compile(r"^\s*function\s+(\w+)")
ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*`(\w+)`\s*\|\s*([\w,-]+)\s*\|")


def found(src="src"):
    out = []
    for root, _, files in os.walk(src):
        for name in sorted(files):
            if not name.endswith(".sol"):
                continue
            path = os.path.join(root, name)
            fn = "<file>"
            for line in open(path, encoding="utf-8"):
                m = FUNC.match(line)
                if m:
                    fn = m.group(1)
                d = DISABLE.search(line)
                if d:
                    out.append((path, fn, d.group(1)))
    return sorted(out)


def documented(doc="SLITHER.md"):
    rows, inside = [], False
    for line in open(doc, encoding="utf-8"):
        if line.startswith("## "):
            inside = line.strip() == "## Inline exceptions in deployable source"
            continue
        m = ROW.match(line) if inside else None
        if m:
            rows.append((m.group(1), m.group(2), m.group(3)))
    return sorted(rows)


def main(argv):
    have, doc = found(), documented()
    missing = [x for x in have if x not in doc]
    stale = [x for x in doc if x not in have]
    for x in missing:
        print("slither-exceptions: undocumented inline disable %s %s %s" % x, file=sys.stderr)
    for x in stale:
        print("slither-exceptions: SLITHER.md row has no matching disable %s %s %s" % x, file=sys.stderr)
    print("slither-exceptions: %d inline disable(s), %d documented" % (len(have), len(doc)), file=sys.stderr)
    return 1 if ("--check" in argv and (missing or stale)) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
