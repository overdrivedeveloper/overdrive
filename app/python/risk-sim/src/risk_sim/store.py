"""Postgres writes (R13). The book is read with a read-only role; results go through a write role. Idempotent per UTC date."""

from __future__ import annotations

import json
from pathlib import Path

JOB = "risk-sim"
MIGRATION = Path(__file__).resolve().parents[5] / "app" / "drizzle" / "0007_risk_sim.sql"
HEARTBEAT_DDL = """CREATE TABLE IF NOT EXISTS service_status (job text PRIMARY KEY, last_run timestamptz, last_ok timestamptz,
  last_error text, last_tx text, meta jsonb NOT NULL DEFAULT '{}'::jsonb)"""


class PgStore:
    def __init__(self, url: str):
        import psycopg

        self.conn = psycopg.connect(url, autocommit=False)

    def close(self) -> None:
        self.conn.close()

    def ensure_schema(self) -> None:
        """Only for fixture and acceptance runs; production gets the tables from the drizzle migration."""
        with self.conn.transaction():
            self.conn.execute(HEARTBEAT_DDL)
            self.conn.execute(MIGRATION.read_text())

    def has_ok_run(self, run_date: str) -> bool:
        row = self.conn.execute("SELECT 1 FROM risk_runs WHERE run_date = %s AND status = 'ok'", (run_date,)).fetchone()
        self.conn.rollback()
        return row is not None

    def latest_plan(self):
        rows = self.conn.execute("SELECT gear, cap_usd FROM risk_caps WHERE run_date = (SELECT max(run_date) FROM risk_caps) ORDER BY gear").fetchall()
        self.conn.rollback()
        return rows

    def save_run(self, run_date: str, report: dict, report_path: str) -> None:
        gate, plan = report["gate"], report["cap_plan"]
        with self.conn.transaction():
            self.conn.execute("DELETE FROM risk_runs WHERE run_date = %s", (run_date,))     # cascades to the two child tables
            self.conn.execute(
                """INSERT INTO risk_runs (run_date, status, gate, worst_loss_usd, worst_scenario, offending_scenario, equity_usd, max_loss_bps,
                   flags, plan, report_path) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                (run_date, report["status"], gate["result"], gate["worst_loss_usd"], gate["worst_scenario"], gate.get("offending_scenario"),
                 report["equity_usd"], report["limit_bps"], report["flags"], json.dumps(plan) if plan else None, report_path))
            for name, r in report["scenarios"].items():
                self.conn.execute(
                    """INSERT INTO risk_scenario_results (run_date, scenario, status, worst_loss_usd, worst_case, contract_budget_usd, flags, detail)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                    (run_date, name, r["status"], r["worst_loss"], r["worst_case"], report["onchain_stress"]["budget_usd"], r["flags"],
                     json.dumps({"cases": r["cases"], "moves": r["moves"], "notes": r["notes"], "extra": r["extra"]}, sort_keys=True)))
            if plan and report["status"] == "ok":
                for c in plan["caps"]:
                    self.conn.execute("INSERT INTO risk_caps (run_date, gear, grp, cap_usd, spec_max_usd, factor, spread_bps) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                                      (run_date, c["gear"], c["group"], c["cap_usd"], c["spec_max_usd"], c["factor"], c["spread_bps"]))

    def save_stale(self, run_date: str, report: dict) -> bool:
        """A stale run never writes caps and never replaces a good run of the same date. Returns whether a row was written."""
        if self.has_ok_run(run_date):
            return False
        with self.conn.transaction():
            self.conn.execute("DELETE FROM risk_runs WHERE run_date = %s", (run_date,))
            self.conn.execute("INSERT INTO risk_runs (run_date, status, gate, equity_usd, max_loss_bps, flags) VALUES (%s,'stale_inputs','unknown',%s,%s,%s)",
                              (run_date, report["equity_usd"], report["limit_bps"], report["stale_reasons"]))
        return True

    def heartbeat(self, ok: bool, meta: dict, error: str | None = None) -> None:
        with self.conn.transaction():
            self.conn.execute(
                """INSERT INTO service_status (job, last_run, last_ok, last_error, meta) VALUES (%s, now(), CASE WHEN %s THEN now() END, %s, %s::jsonb)
                   ON CONFLICT (job) DO UPDATE SET last_run = now(), last_ok = CASE WHEN %s THEN now() ELSE service_status.last_ok END,
                   last_error = %s, meta = EXCLUDED.meta""",
                (JOB, ok, error, json.dumps(meta, sort_keys=True), ok, error))


def read_conn(url: str):
    """The book is read through a connection that the server itself holds read-only, whatever role the URL names."""
    import psycopg

    return psycopg.connect(url, options="-c default_transaction_read_only=on")
