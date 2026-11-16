"""report.json (byte-reproducible: sorted keys, rounded floats, no wall-clock) and report.md."""

from __future__ import annotations

import json
from dataclasses import asdict

from .book import Book


def _round(x):
    if isinstance(x, float):
        return round(x, 6)
    if isinstance(x, dict):
        return {k: _round(v) for k, v in sorted(x.items())}
    if isinstance(x, (list, tuple)):
        return [_round(v) for v in x]
    return x


def build_report(run_date: str, book: Book, results: dict, gate: dict, plan, onchain: dict, settings, flags: list, stale: list) -> dict:
    return _round({
        "run_date": run_date,
        "as_of": book.as_of,
        "status": "stale_inputs" if stale else "ok",
        "stale_reasons": stale,
        "equity_usd": book.equity_usd,
        "limit_bps": settings.max_loss_bps,
        "limit_usd": book.equity_usd * settings.max_loss_bps / 1e4,
        "gate": gate,
        "flags": sorted(flags),
        "onchain_stress": onchain,
        "scenarios": {n: asdict(r) for n, r in sorted(results.items())},
        "cap_plan": None if plan is None else asdict(plan),
        "hedge_stale": book.hedge_stale,
        "seed": settings.seed,
    })


def dumps(report: dict) -> str:
    return json.dumps(report, sort_keys=True, indent=2, ensure_ascii=True) + "\n"


def to_markdown(rep: dict) -> str:
    L = [f"# Risk run {rep['run_date']}", "", f"Status: {rep['status']}. Gate: **{rep['gate']['result']}**"
         f" (worst loss {rep['gate']['worst_loss_usd']:,.0f} USD in `{rep['gate']['worst_scenario']}`, limit {rep['limit_usd']:,.0f} USD"
         f" = {rep['limit_bps']} bps of equity {rep['equity_usd']:,.0f}).", ""]
    if rep["flags"]:
        L += ["Flags: " + ", ".join(rep["flags"]), ""]
    oc = rep["onchain_stress"]
    L += [f"On-chain stress rule reproduced: loss {oc['loss_usd']:,.0f} against budget {oc['budget_usd']:,.0f} USD.", "",
          "## Scenarios", "", "| Scenario | Status | Worst loss USD | Worst case | Flags |", "|---|---|---|---|---|"]
    for n, r in rep["scenarios"].items():
        L.append(f"| {n} | {r['status']} | {r['worst_loss']:,.0f} | {r['worst_case']} | {', '.join(r['flags'])} |")
    for n, r in rep["scenarios"].items():
        L += ["", f"### {n}: {r['title']}", ""] + [f"- {x}" for x in r["notes"]]
        if r["moves"]:
            L += ["", "Moves used:", ""] + [f"- {json.dumps(m, sort_keys=True)}" for m in r["moves"][:60]]
        if r["extra"].get("exit"):
            L += ["", "Exit reserve: " + json.dumps(r["extra"]["exit"], sort_keys=True)]
    if rep["cap_plan"]:
        p = rep["cap_plan"]
        L += ["", "## Recommended caps (recommendation only, moves through the 48 h timelock)", "",
              f"Group factors: {json.dumps(p['factors'], sort_keys=True)}", "", "| Gear | Group | Cap USD | Spec max USD |", "|---|---|---|---|"]
        L += [f"| {c['gear']} | {c['group']} | {c['cap_usd']:,.0f} | {c['spec_max_usd']:,.0f} |" for c in p["caps"]]
    return "\n".join(L) + "\n"
