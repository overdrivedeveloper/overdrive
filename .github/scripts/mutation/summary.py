"""Summarise mutation results. First file: the scored run. Later files override verdicts by id (a broad
re-run of a narrow survivor). Score = killed / (killed + survived + timeout); uncompiled is not scored
(timeouts count against the score: a mutant that hangs the suite is not proven killed)."""

import json
import sys
from collections import OrderedDict, defaultdict
from pathlib import Path


def load(p):
    path = Path(p)
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def main():
    rows = OrderedDict()
    for r in load(sys.argv[1]):
        rows[r["id"]] = r
    for p in sys.argv[2:]:
        for r in load(p):
            if r["id"] in rows:
                rows[r["id"]] = dict(rows[r["id"]], verdict=r["verdict"], killer=r.get("killer", ""))
    agg = defaultdict(lambda: defaultdict(int))
    for r in rows.values():
        agg[r["contract"]][r["verdict"]] += 1
    print("| Contract | Run | Killed | Survived | Timed out | Uncompiled | Score |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    tot = defaultdict(int)
    for c in sorted(agg):
        a = agg[c]
        for k, v in a.items():
            tot[k] += v
        scored = a["killed"] + a["survived"] + a["timeout"]
        n = scored + a["uncompiled"]
        s = f"{100 * a['killed'] / scored:.1f}%" if scored else "n/a"
        print(f"| {c} | {n} | {a['killed']} | {a['survived']} | {a['timeout']} | {a['uncompiled']} | {s} |")
    scored = tot["killed"] + tot["survived"] + tot["timeout"]
    s = f"{100 * tot['killed'] / scored:.1f}%" if scored else "n/a"
    print(f"| **All** | {scored + tot['uncompiled']} | {tot['killed']} | {tot['survived']} | {tot['timeout']} | {tot['uncompiled']} | **{s}** |")
    surv = [r for r in rows.values() if r["verdict"] in ("survived", "timeout")]
    if surv:
        print("\nSurvivors:\n")
        for r in surv:
            old = r["old"].strip().replace("\n", " ")[:90]
            new = r["new"].strip().replace("\n", " ")[:90]
            print(f"- {r['id']} {r['file']}:{r['line']} {r['op']} {r['verdict']}: `{old}` -> `{new}`")


if __name__ == "__main__":
    main()
