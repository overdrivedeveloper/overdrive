"""The Governor book: gears, equity, exit reserve, hedge position, sigma. Immutable; scenarios never mutate it."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

from .config import SPEC_GROUPS, floor_for, is_crypto
from .index import NAMES

USDG = 1e6
WAD = 1e18


@dataclass(frozen=True)
class GearPos:
    id: str
    key: str                       # "TSLA" or "NVDA/AMD" (A over B)
    power: float
    supply_tokens: float           # all holders
    backer_debt_tokens: float      # minted against backer vaults: hits the vault, not Governor equity (R3)
    value_per_token: float         # USD per token now (NF x index)
    cap_usd: float = 0.0
    toll_usd_per_year: float | None = None   # override; else computed from sigma
    usage_max: float = 0.0

    @property
    def legs(self) -> tuple[str, ...]:
        return tuple(self.key.split("/"))

    @property
    def is_pair(self) -> bool:
        return "/" in self.key

    @property
    def governor_value_usd(self) -> float:
        return max(0.0, self.supply_tokens - self.backer_debt_tokens) * self.value_per_token

    @property
    def label(self) -> str:
        return f"{self.key}:{NAMES.get(self.power, self.power)}"


@dataclass(frozen=True)
class Book:
    gears: tuple[GearPos, ...]
    equity_usd: float
    exit_reserve_usd: float = 0.0
    exit_reserve_floor_usd: float = 0.0
    hedge_position_usd: dict = field(default_factory=dict)      # underlying -> signed USD notional (long positive)
    sigma_bps: dict = field(default_factory=dict)               # key -> posted sigma in bps (missing -> floor, flagged)
    hedge_stale: bool = False
    as_of: str = ""
    book_ts: str = ""
    price_ts: str = ""
    flags: tuple = ()

    @property
    def underlyings(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for g in self.gears:
            for leg in g.legs:
                seen[leg] = None
        return tuple(sorted(seen))

    @property
    def stocks(self) -> tuple[str, ...]:
        return tuple(u for u in self.underlyings if not is_crypto(u))

    def sigma(self, key: str) -> tuple[float, bool]:
        """(sigma as a fraction, was_missing). A missing sigma uses the floor, never a lower value."""
        v = self.sigma_bps.get(key)
        if v is None:
            return floor_for(key), True
        return max(float(v) / 10_000.0, floor_for(key)), False

    def with_gears(self, gears) -> "Book":
        return replace(self, gears=tuple(gears))

    def total_governor_value(self) -> float:
        return sum(g.governor_value_usd for g in self.gears)


def _iso(ts) -> str:
    if ts is None:
        return ""
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(ts, datetime) else str(ts)


def parse_ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def load_fixture(path: str | Path) -> Book:
    d = json.loads(Path(path).read_text())
    gears = tuple(GearPos(id=g["id"], key=g["key"], power=float(g["power"]), supply_tokens=float(g["supply_tokens"]),
                          backer_debt_tokens=float(g.get("backer_debt_tokens", 0)), value_per_token=float(g["value_per_token"]),
                          cap_usd=float(g.get("cap_usd", 0)), toll_usd_per_year=g.get("toll_usd_per_year"),
                          usage_max=float(g.get("usage_max", 0))) for g in d["gears"])
    return Book(gears=gears, equity_usd=float(d["equity_usd"]), exit_reserve_usd=float(d.get("exit_reserve_usd", 0)),
                exit_reserve_floor_usd=float(d.get("exit_reserve_floor_usd", 0)),
                hedge_position_usd={k: float(v) for k, v in d.get("hedge_position_usd", {}).items()},
                sigma_bps={k: float(v) for k, v in d.get("sigma_bps", {}).items()}, hedge_stale=bool(d.get("hedge_stale", False)),
                as_of=d.get("as_of", ""), book_ts=d.get("book_ts", d.get("as_of", "")), price_ts=d.get("price_ts", d.get("as_of", "")))


def market_key(key: str) -> str:
    """The indexer stores vol_posts under the on-chain market id (0x + bytes32, the symbol's ASCII, zero padded); the book keys gears
    by symbol. A key that is not a printable-ASCII market id (a pair hash, a gear id, a symbol) is returned unchanged."""
    if len(key) == 66 and key.startswith("0x"):
        try:
            raw = bytes.fromhex(key[2:]).rstrip(b"\0")
        except ValueError:
            return key
        if raw and all(0x20 < b < 0x7f for b in raw) and b"\0" not in raw:
            return raw.decode("ascii")
    return key


def load_book(conn, as_of: datetime) -> Book:
    """Reads the indexer schema (todo 13) with a read-only connection. Units: USDG raw 6 dp, tokens and NF WAD."""
    cur = conn.cursor()
    cur.execute("SELECT max(ts) FROM governor_ledger WHERE ts <= %s", (as_of,))
    ledger_ts = cur.fetchone()[0]
    if ledger_ts is None:
        raise LookupError("no governor_ledger rows: the indexer has not run")
    cur.execute("SELECT underlying, hedge_delta, equity, exit_reserve FROM governor_ledger WHERE ts = %s", (ledger_ts,))
    rows = cur.fetchall()
    equity = float(rows[0][2]) / USDG
    hedge = {r[0]: float(r[1]) / USDG for r in rows}
    reserve = float(rows[0][3]) / USDG
    cur.execute('SELECT balance, "floor" FROM exit_reserve_log WHERE ts <= %s ORDER BY ts DESC, block DESC LIMIT 1', (as_of,))
    er = cur.fetchone()
    floor = float(er[1]) / USDG if er else 0.0
    reserve = float(er[0]) / USDG if er else reserve
    cur.execute("SELECT id, underlying, underlying_b, power, token, cap_usd FROM gears WHERE status <> 'retired' ORDER BY id")
    gear_rows = cur.fetchall()
    gears = []
    for gid, ua, ub, power, token, cap in gear_rows:
        cur.execute("SELECT coalesce(sum(balance),0) FROM balances WHERE token = %s AND account <> %s",
                    (token, "0x0000000000000000000000000000000000000000"))
        supply = float(cur.fetchone()[0]) / WAD
        cur.execute("SELECT coalesce(sum(debt_tokens),0) FROM backer_vaults WHERE gear = %s AND status <> 'closed'", (gid,))
        debt = float(cur.fetchone()[0]) / WAD
        cur.execute("SELECT value_per_token FROM trades WHERE gear = %s AND value_per_token IS NOT NULL ORDER BY ts DESC, block DESC LIMIT 1", (gid,))
        v = cur.fetchone()
        if v is None:
            continue
        gears.append(GearPos(id=gid, key=f"{ua}/{ub}" if ub else ua, power=float(power), supply_tokens=supply, backer_debt_tokens=debt,
                             value_per_token=float(v[0]) / WAD, cap_usd=float(cap) / USDG))
    cur.execute("SELECT DISTINCT ON (gear_or_underlying) gear_or_underlying, sigma_bps FROM vol_posts ORDER BY gear_or_underlying, ts DESC")
    sigma = {market_key(r[0]): float(r[1]) for r in cur.fetchall()}
    cur.execute("SELECT max(ts) FROM prices")
    price_ts = cur.fetchone()[0]
    cur.execute("SELECT meta FROM service_status WHERE job = 'hedger'")
    st = cur.fetchone()
    stale = bool(st and (st[0] or {}).get("hedgeStale"))
    return Book(gears=tuple(gears), equity_usd=equity, exit_reserve_usd=reserve, exit_reserve_floor_usd=floor, hedge_position_usd=hedge,
                sigma_bps=sigma, hedge_stale=stale, as_of=_iso(as_of), book_ts=_iso(ledger_ts), price_ts=_iso(price_ts))


def freshness(book: Book, now_ts: float, max_book_age_s: int, max_price_age_s: int, names: tuple[str, ...] | None = None) -> list[str]:
    """R11: reasons the inputs are stale. Empty list means fresh."""
    reasons = []
    if not book.book_ts or now_ts - parse_ts(book.book_ts) > max_book_age_s:
        reasons.append("book_stale")
    if not book.price_ts or now_ts - parse_ts(book.price_ts) > max_price_age_s:
        reasons.append("price_stale")
    for key in sorted({g.key for g in book.gears}):
        if book.sigma_bps.get(key) is None:
            reasons.append(f"sigma_missing:{key}")
    return sorted(set(reasons))
