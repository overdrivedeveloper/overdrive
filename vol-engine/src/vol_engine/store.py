"""Data access. The engine reads prices, earnings dates and posts, and writes intent and alert rows only."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Protocol

from .bars import Tick
from .config import ALERT_REPEAT_S
from .earnings import EarningsRow

STATUSES = ("planned", "dry_run", "sent", "accepted", "dropped", "rejected")


@dataclass
class Intent:
    market: str           # 0x bytes32
    key: str              # "NVDA" or "NVDA/AMD"
    sigma_bps: int
    buy_block_from: int
    buy_block_to: int
    valid_until: int
    nonce: int
    status: str           # planned | dry_run | sent | accepted | dropped | rejected
    flags: list[str] = field(default_factory=list)
    tx_hash: str | None = None
    created_at: float = 0.0
    digest: str = ""
    signature: str = ""
    id: int | None = None


class Store(Protocol):
    def prices(self, key: str, market_hex: str, since_ts: float) -> list[Tick]: ...
    def earnings(self, symbol: str) -> list[EarningsRow]: ...
    def chain_post(self, market_hex: str) -> tuple[int, float, int] | None: ...   # (sigma_bps, posted_at, valid_until) from vol_posts
    def intent_reference(self, market_hex: str, statuses: tuple[str, ...]) -> Intent | None: ...
    def last_intent(self, market_hex: str) -> Intent | None: ...
    def write_intent(self, intent: Intent) -> int: ...
    def mark_intent(self, intent_id: int, status: str, tx_hash: str | None = None) -> None: ...
    def pending_intents(self) -> list[Intent]: ...
    def write_alert(self, market_hex: str, kind: str, detail: dict, ts: float) -> bool: ...


class MemoryStore:
    """In-memory store for tests and dry fixtures."""

    def __init__(self) -> None:
        self.tick_rows: dict[str, list[Tick]] = {}
        self.earnings_rows: list[EarningsRow] = []
        self.chain_posts: dict[str, tuple[int, float, int]] = {}
        self.intents: list[Intent] = []
        self.alerts: list[dict] = []

    def prices(self, key: str, market_hex: str, since_ts: float) -> list[Tick]:
        return [t for t in self.tick_rows.get(key.upper(), []) if t.ts >= since_ts]

    def earnings(self, symbol: str) -> list[EarningsRow]:
        return [r for r in self.earnings_rows if r.symbol == symbol.upper()]

    def chain_post(self, market_hex: str) -> tuple[int, float, int] | None:
        return self.chain_posts.get(market_hex)

    def intent_reference(self, market_hex: str, statuses: tuple[str, ...]) -> Intent | None:
        mine = [i for i in self.intents if i.market == market_hex and i.status in statuses]
        return max(mine, key=lambda i: (i.created_at, i.nonce)) if mine else None

    def last_intent(self, market_hex: str) -> Intent | None:
        mine = [i for i in self.intents if i.market == market_hex and i.status not in ("dropped", "rejected")]
        return max(mine, key=lambda i: i.nonce) if mine else None

    def write_intent(self, intent: Intent) -> int:
        intent.id = len(self.intents) + 1
        self.intents.append(intent)
        return intent.id

    def mark_intent(self, intent_id: int, status: str, tx_hash: str | None = None) -> None:
        for i in self.intents:
            if i.id == intent_id:
                i.status = status
                if tx_hash is not None:
                    i.tx_hash = tx_hash

    def pending_intents(self) -> list[Intent]:
        return [i for i in self.intents if i.status in ("planned", "sent")]

    def write_alert(self, market_hex: str, kind: str, detail: dict, ts: float) -> bool:
        for a in reversed(self.alerts):
            if a["market"] == market_hex and a["kind"] == kind:
                if a["detail"] == detail and ts - a["created_at"] < ALERT_REPEAT_S:
                    a["repeated_at"] = ts
                    return False
                break
        self.alerts.append({"market": market_hex, "kind": kind, "detail": detail, "created_at": ts, "repeated_at": None})
        return True


def _dt(ts: float) -> datetime | None:
    return datetime.fromtimestamp(ts, timezone.utc) if ts else None


class PgStore:
    """Postgres store. Two connections: a read-only one (the server enforces it) and one for writing intents and alerts."""

    def __init__(self, database_url: str) -> None:
        import psycopg

        # The server enforces read-only for the whole session (psycopg's read_only flag does not apply in autocommit).
        self._reader: Any = psycopg.connect(database_url, autocommit=True, options="-c default_transaction_read_only=on")
        self._writer: Any = psycopg.connect(database_url, autocommit=True)

    def close(self) -> None:
        self._reader.close()
        self._writer.close()

    def prices(self, key: str, market_hex: str, since_ts: float) -> list[Tick]:
        # `underlying` is the symbol; the market hex is accepted too. Last row per 5-minute bucket keeps the transfer small.
        sql = """
            SELECT DISTINCT ON (b) extract(epoch from ts)::float8, (price_wad / 1e18)::float8, session, fresh FROM (
              SELECT ts, price_wad, session, fresh, floor(extract(epoch from ts) / 300) AS b
              FROM prices WHERE (upper(underlying) = %s OR lower(underlying) = %s) AND ts >= to_timestamp(%s)
            ) t ORDER BY b, ts DESC"""
        rows = self._reader.execute(sql, (key.upper(), market_hex.lower(), since_ts)).fetchall()
        return sorted((Tick(r[0], r[1], r[2] or "UNKNOWN", bool(r[3])) for r in rows), key=lambda t: t.ts)

    def earnings(self, symbol: str) -> list[EarningsRow]:
        rows = self._reader.execute(
            "SELECT symbol, report_date, session, source FROM earnings_dates WHERE symbol = %s AND report_date >= current_date - 1",
            (symbol.upper(),),
        ).fetchall()
        return [EarningsRow(r[0], r[1] if isinstance(r[1], date) else date.fromisoformat(str(r[1])), r[2], r[3]) for r in rows]

    def chain_post(self, market_hex: str) -> tuple[int, float, int] | None:
        r = self._reader.execute(
            "SELECT sigma_bps, extract(epoch from ts)::float8, extract(epoch from valid_until)::float8 FROM vol_posts "
            "WHERE lower(gear_or_underlying) = %s ORDER BY ts DESC LIMIT 1", (market_hex.lower(),)).fetchone()
        return (int(r[0]), float(r[1]), int(r[2] or 0)) if r else None

    _COLS = ("id, market, key, sigma_bps, extract(epoch from buy_block_from), extract(epoch from buy_block_to), "
             "extract(epoch from valid_until), nonce, status, tx_hash, extract(epoch from created_at), digest, signature, flags")

    @staticmethod
    def _intent(r: Any) -> Intent:
        return Intent(r[1], r[2] or "", int(r[3]), int(r[4] or 0), int(r[5] or 0), int(r[6]), int(r[7]), r[8], list(r[13] or []),
                      r[9], float(r[10]), r[11] or "", r[12] or "", int(r[0]))

    def intent_reference(self, market_hex: str, statuses: tuple[str, ...]) -> Intent | None:
        r = self._reader.execute(
            f"SELECT {self._COLS} FROM vol_post_intents WHERE market = %s AND status = ANY(%s) "
            "ORDER BY created_at DESC, nonce DESC LIMIT 1", (market_hex, list(statuses))).fetchone()
        return self._intent(r) if r else None

    def last_intent(self, market_hex: str) -> Intent | None:
        r = self._reader.execute(
            f"SELECT {self._COLS} FROM vol_post_intents WHERE market = %s AND status NOT IN ('dropped','rejected') "
            "ORDER BY nonce DESC LIMIT 1", (market_hex,)).fetchone()
        return self._intent(r) if r else None

    def write_intent(self, i: Intent) -> int:
        # created_at is the time the pass planned with (wall, or the chain's with VOL_CLOCK=chain).
        r = self._writer.execute(
            "INSERT INTO vol_post_intents (market, key, sigma_bps, buy_block_from, buy_block_to, valid_until, nonce, status, "
            "tx_hash, flags, created_at, digest, signature) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (i.market, i.key, i.sigma_bps, _dt(i.buy_block_from), _dt(i.buy_block_to), _dt(i.valid_until), i.nonce, i.status,
             i.tx_hash, i.flags, _dt(i.created_at), i.digest, i.signature)).fetchone()
        i.id = int(r[0])
        return i.id

    def mark_intent(self, intent_id: int, status: str, tx_hash: str | None = None) -> None:
        self._writer.execute("UPDATE vol_post_intents SET status = %s, tx_hash = COALESCE(%s, tx_hash) WHERE id = %s",
                             (status, tx_hash, intent_id))

    def pending_intents(self) -> list[Intent]:
        rows = self._reader.execute(
            f"SELECT {self._COLS} FROM vol_post_intents WHERE status IN ('planned','sent')").fetchall()
        return [self._intent(r) for r in rows]

    def write_alert(self, market_hex: str, kind: str, detail: dict, ts: float) -> bool:
        prev = self._writer.execute(
            "SELECT id, detail, extract(epoch from created_at)::float8 FROM vol_alerts WHERE market = %s AND kind = %s "
            "ORDER BY id DESC LIMIT 1", (market_hex, kind)).fetchone()
        if prev and prev[1] == detail and ts - prev[2] < ALERT_REPEAT_S:
            self._writer.execute("UPDATE vol_alerts SET repeated_at = to_timestamp(%s) WHERE id = %s", (ts, prev[0]))
            return False
        self._writer.execute("INSERT INTO vol_alerts (market, kind, detail, created_at) VALUES (%s,%s,%s::jsonb,to_timestamp(%s))",
                             (market_hex, kind, json.dumps(detail), ts))
        return True
