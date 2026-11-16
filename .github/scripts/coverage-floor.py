#!/usr/bin/env python3
"""TEST-5: compares a fresh coverage summary (.github/scripts/coverage.sh writes contracts/coverage/summary.md) with the
recorded floor in security/audit-grade/coverage.md (its "src/ total" row). Fails when lines, branches or functions fall
below the recorded figure. The floor only moves up: rerun with --record after a rise, never edit it down.
Usage: python3 .github/scripts/coverage-floor.py <summary.md> <security/audit-grade/coverage.md> [--record]"""
import re
import sys

ROW = re.compile(r"\*\*src/ total\*\*.*?\*\*([\d.]+)%\*\*.*?\*\*([\d.]+)%\*\*.*?\*\*([\d.]+)%\*\*")


def totals(path):
    for line in open(path, encoding="utf-8"):
        m = ROW.search(line)
        if m:
            return tuple(float(x) for x in m.groups()), line.strip()
    raise SystemExit(f"coverage-floor: no src/ total row in {path}")


def main(argv):
    new, row = totals(argv[0])
    if "--record" in argv:
        body = open(argv[0], encoding="utf-8").read()
        old = None
        try:
            old, _ = totals(argv[1])
        except (OSError, SystemExit):
            pass
        if old and any(n < o for n, o in zip(new, old)):
            print("coverage-floor: refusing to record a lower figure than the floor", file=sys.stderr)
            return 1
        head = ("# Coverage of contracts/src (TEST-5)\n\nRecorded by `.github/scripts/coverage-floor.py --record` from "
                "`bash .github/scripts/coverage.sh` (forge coverage --ir-minimum, hermetic suite, src/ only; via_ir source "
                "maps make these a floor, not exact). `.github/scripts/ci-local.sh --only coverage` fails when a fresh run "
                "is below the src/ total row. The floor is never lowered.\n\n")
        open(argv[1], "w", encoding="utf-8").write(head + body)
        print("coverage-floor: recorded " + row)
        return 0
    floor, _ = totals(argv[1])
    names = ("lines", "branches", "functions")
    bad = [f"{n} {v:.2f}% < floor {f:.2f}%" for n, v, f in zip(names, new, floor) if v + 1e-9 < f]
    for b in bad:
        print("coverage-floor: " + b, file=sys.stderr)
    print("coverage-floor: " + ("FAIL" if bad else "ok") + " " + row)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
