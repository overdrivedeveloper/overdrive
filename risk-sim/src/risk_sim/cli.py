"""risk-sim CLI. A failed gate is data: exit 0, row in risk_runs, line in the Telegram outbox."""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config as C
from .book import Book, freshness, load_book, load_fixture, parse_ts
from .caps import recommend_caps
from .governor import onchain_stress
from .hedge_model import HedgeModel
from .logs import log
from .report import build_report, dumps, to_markdown
from .scenarios import SCENARIOS, Context, budget_flags, run_all, worst_of


def _outbox(settings: C.Settings, line: str) -> None:
    if settings.telegram_outbox:
        p = Path(settings.telegram_outbox)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as f:
            f.write(line + "\n")


def evaluate(book: Book, settings: C.Settings, only: list | None = None, with_plan: bool = True) -> tuple[dict, dict, dict, object]:
    hedge = HedgeModel.from_settings(settings)
    ctx = Context(seed=settings.seed)
    results = run_all(book, hedge, ctx, only)
    loss, budget, per = onchain_stress(book, settings.onchain_shock_bps, settings.max_loss_bps)
    onchain = {"loss_usd": loss, "budget_usd": budget, "shock_bps": settings.onchain_shock_bps, "per_market": per, "hedge_counted_zero": book.hedge_stale}
    for n, fl in budget_flags(results, budget).items():
        results[n].flags = sorted(set(results[n].flags) | set(fl))
    worst, name = worst_of(results)
    limit = max(book.equity_usd, 0.0) * settings.max_loss_bps / 1e4
    exit_short = any("exit_reserve_short" in r.flags for r in results.values())
    bad = worst > limit or exit_short
    gate = {"result": "fail" if bad else "pass", "worst_loss_usd": worst, "worst_scenario": name, "limit_usd": limit,
            "offending_scenario": (name if worst > limit else "exit_run") if bad else None}
    plan = recommend_caps(book, results, settings.max_loss_bps, hedge=hedge, ctx=Context(seed=settings.seed, vol_paths=3)) if with_plan else None
    return results, onchain, gate, plan


def cmd_run(args, settings: C.Settings) -> int:
    book = load_fixture(args.from_fixture) if args.from_fixture else None
    store = None
    if settings.database_url and (args.nightly or not args.from_fixture):
        from .store import PgStore

        store = PgStore(settings.write_database_url or settings.database_url)
        if args.from_fixture:
            store.ensure_schema()
    now = datetime.fromtimestamp(float(args.now), timezone.utc) if args.now else (
        datetime.fromtimestamp(parse_ts(book.as_of), timezone.utc) if book and book.as_of else datetime.now(timezone.utc))
    if book is None:
        if store is None:
            print("error: DATABASE_URL (or --from-fixture) is required", file=sys.stderr)
            return 2
        from .store import read_conn

        with read_conn(settings.database_url) as rc:
            book = load_book(rc, now)
    run_date = args.date or now.strftime("%Y-%m-%d")
    stale = freshness(book, now.timestamp(), settings.max_book_age_s, C.STALE_PRICE_S)
    if stale:
        rep = build_report(run_date, book, {}, {"result": "unknown", "worst_loss_usd": 0.0, "worst_scenario": "", "limit_usd": 0.0}, None,
                           {"loss_usd": 0.0, "budget_usd": 0.0}, settings, ["stale_inputs"], stale)
        wrote = store.save_stale(run_date, rep) if store else False
        if store:
            store.heartbeat(False, {"run_date": run_date, "stale": stale}, "stale_inputs")
        _outbox(settings, f"risk-sim {run_date}: stale inputs ({', '.join(stale)}); previous cap plan kept")
        log("stale_inputs", reasons=stale, row_written=wrote)
        print(json.dumps({"status": "stale_inputs", "reasons": stale}, sort_keys=True))
        return 0
    only = [args.scenario] if args.scenario else None
    if only and only[0] not in SCENARIOS:
        print(f"error: unknown scenario {only[0]} (known: {', '.join(SCENARIOS)})", file=sys.stderr)
        return 2
    results, onchain, gate, plan = evaluate(book, settings, only, with_plan=bool(args.nightly))
    flags = sorted({f for r in results.values() for f in r.flags})
    rep = build_report(run_date, book, results, gate, plan, onchain, settings, flags, [])
    out = Path(args.out_dir or settings.out_dir) / run_date
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(dumps(rep))
    (out / "report.md").write_text(to_markdown(rep))
    if store and args.nightly:
        store.save_run(run_date, rep, str(out / "report.json"))
        store.heartbeat(True, {"run_date": run_date, "gate": gate["result"], "worst_loss_usd": gate["worst_loss_usd"]})
    if gate["result"] == "fail":
        _outbox(settings, f"risk-sim {run_date}: GATE FAIL, worst loss {gate['worst_loss_usd']:,.0f} USD in {gate['offending_scenario']} "
                          f"vs limit {gate['limit_usd']:,.0f} USD; lower caps recommended (timelock)")
    print(json.dumps({"status": "ok", "gate": gate["result"], "worst_loss_usd": round(gate["worst_loss_usd"], 2), "worst_scenario": gate["worst_scenario"],
                      "report": str(out / "report.json")}, sort_keys=True))
    if store:
        store.close()
    return 0


def cmd_caps(args, settings: C.Settings) -> int:
    book = Book(gears=(), equity_usd=args.equity, sigma_bps={})
    plan = recommend_caps(book, None, args.max_loss_bps or settings.max_loss_bps, hedge=HedgeModel.from_settings(settings), ctx=Context(seed=settings.seed, vol_paths=3))
    print(f"equity {plan.equity_usd:,.0f} USD, limit {plan.limit_usd:,.0f} USD, worst scenario loss at the plan {plan.worst_loss_usd:,.0f} USD")
    print(f"{'group':<8}{'factor':>10}{'cap per gear USD':>20}{'spec max USD':>16}{'spread bps':>12}")
    for g, f in sorted(plan.factors.items()):
        spec = C.SPEC_GROUPS[g]
        print(f"{g:<8}{f:>10.4f}{spec['cap_usd'] * f:>20,.0f}{spec['cap_usd']:>16,.0f}{spec['spread_bps']:>12}")
    return 0


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(prog="risk-sim")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--nightly", action="store_true")
    r.add_argument("--scenario")
    r.add_argument("--from-fixture")
    r.add_argument("--date")
    r.add_argument("--now", help="unix seconds; tests only")
    r.add_argument("--out-dir")
    c = sub.add_parser("caps")
    c.add_argument("--equity", type=float, required=True)
    c.add_argument("--max-loss-bps", type=int)
    sub.add_parser("fetch-history")
    args = ap.parse_args(argv)
    try:
        settings = C.Settings.from_env()
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if args.cmd == "run":
        return cmd_run(args, settings)
    if args.cmd == "caps":
        return cmd_caps(args, settings)
    from .history import fetch_all

    print(json.dumps(fetch_all()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
