"""Compute, guard, sign and (optionally) send one ODVolOracle post per market (a name or a pair gear)."""

from __future__ import annotations

import logging
import time as _time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Protocol

from eth_abi import decode, encode
from eth_utils import keccak, to_checksum_address

from .bars import EXTENDED, build_bars, ratio_ticks
from .calendar import closed_run_now
from .config import (
    BOUNDS_REFRESH_S,
    CLOCK_SKEW_LIMIT_S,
    EVENT_TAU_EARNINGS_S,
    HALF_LIFE_FAST_DAYS,
    HALF_LIFE_SLOW_DAYS,
    HARD_MAX_CEILING_BPS,
    HARD_MIN_FLOOR_BPS,
    LOOKBACK_DAYS,
    MARKUP,
    MAX_TICK_AGE_S,
    MIN_POST_INTERVAL_S,
    MIN_RELATIVE_CHANGE,
    MIN_VALIDITY_S,
    PENDING_TTL_S,
    RACE_MARKETS,
    RENEW_FRACTION,
    Settings,
    floor_for,
)
from .earnings import block_window, reconcile, report_times
from .guard import ChainState, bounds_ceiling, clamp_step
from .history import History
from .markets import Market, listed, resolve
from .realized import ratio_bars, sigma_scale
from .sender import Sender, Transport
from .signer import market_key, sign_post, VolPost
from .store import Intent, Store
from .surface import add_event_variance, earnings_move, earnings_weight, sigma_hat, to_bps, weekend_move, weekend_weight

log = logging.getLogger("vol_engine")

BPS = 10_000


class ClockError(RuntimeError):
    """The wall clock disagrees with the chain (a warped fork); names the setting that fixes it."""


# ---------------------------------------------------------------- the oracle's own state

class Oracle(Protocol):
    def state(self, market_hex: str) -> ChainState: ...
    def bounds(self, market_hex: str, now_s: float) -> tuple[int, int]: ...


def _call(rpc: Transport, oracle: str, sig: str, args_types: list[str], args: list) -> bytes:
    data = keccak(text=sig)[:4] + (encode(args_types, args) if args_types else b"")
    raw = rpc("eth_call", [{"to": to_checksum_address(oracle), "data": "0x" + data.hex()}, "latest"])
    return bytes.fromhex(str(raw)[2:])


def read_bounds(rpc: Transport, oracle: str, market: bytes) -> tuple[int, int]:
    """The oracle's own (floorBps, ceilingBps) for a market; the engine clamps into them."""
    out = decode(["uint64", "uint64"], _call(rpc, oracle, "bounds(bytes32)", ["bytes32"], [market]))
    return int(out[0]), int(out[1])


def read_state(rpc: Transport, oracle: str, market: bytes) -> ChainState:
    r = decode(["uint64", "uint64", "uint64", "uint64", "uint64", "bool", "bool"],
               _call(rpc, oracle, "read(bytes32)", ["bytes32"], [market]))
    nonce = decode(["uint64"], _call(rpc, oracle, "lastNonce(bytes32)", ["bytes32"], [market]))[0]
    return ChainState(int(r[0]), int(r[1]), int(r[2]), int(nonce), int(r[3]), int(r[4]))


def read_constants(rpc: Transport, oracle: str) -> dict[str, int]:
    """The deployed oracle's own timers; they win over the VOL_* fallbacks."""
    names = {"min_post_interval_s": "MIN_POST_INTERVAL()", "max_validity_s": "HARD_MAX_VALIDITY()"}
    return {k: int(decode(["uint64"], _call(rpc, oracle, sig, [], []))[0]) for k, sig in names.items()}


class RpcOracle:
    """Reads the deployed oracle. Bounds are cached and refreshed hourly; state is read fresh on every pass."""

    def __init__(self, rpc: Transport, oracle: str, refresh_s: int = BOUNDS_REFRESH_S) -> None:
        self._rpc, self._oracle, self._refresh = rpc, oracle, refresh_s
        self._bounds: dict[str, tuple[float, tuple[int, int]]] = {}

    def state(self, market_hex: str) -> ChainState:
        return read_state(self._rpc, self._oracle, bytes.fromhex(market_hex[2:]))

    def bounds(self, market_hex: str, now_s: float) -> tuple[int, int]:
        hit = self._bounds.get(market_hex)
        if hit and now_s - hit[0] < self._refresh:
            return hit[1]
        b = read_bounds(self._rpc, self._oracle, bytes.fromhex(market_hex[2:]))
        self._bounds[market_hex] = (now_s, b)
        return b


class StoreOracle:
    """No RPC: the last post is the newest of the indexer's `vol_posts` row and our own accepted (or dry-run) intent."""

    def __init__(self, store: Store, include_dry_run: bool = True) -> None:
        self._store = store
        self._statuses = ("accepted", "dry_run") if include_dry_run else ("accepted",)

    def state(self, market_hex: str) -> ChainState:
        chain = self._store.chain_post(market_hex)
        mine = self._store.intent_reference(market_hex, self._statuses)
        cands = []
        if chain:
            cands.append((chain[1], ChainState(chain[0], int(chain[1]), chain[2], 0)))
        if mine:
            cands.append((mine.created_at, ChainState(mine.sigma_bps, int(mine.created_at), mine.valid_until, mine.nonce,
                                                       mine.buy_block_from, mine.buy_block_to)))
        if not cands:
            return ChainState()
        newest = max(cands, key=lambda c: c[0])[1]
        nonce = max([mine.nonce] if mine else [0])
        return ChainState(newest.sigma_bps, newest.posted_at, newest.valid_until, nonce, newest.buy_block_from, newest.buy_block_to)

    def bounds(self, market_hex: str, now_s: float) -> tuple[int, int]:
        return HARD_MIN_FLOOR_BPS, HARD_MAX_CEILING_BPS


def make_oracle(settings: Settings, store: Store, transport: Transport | None = None) -> Oracle:
    if settings.rpc_url and settings.oracle_address:
        from .sender import http_transport
        return RpcOracle(transport or http_transport(settings.rpc_url), settings.oracle_address)
    return StoreOracle(store, include_dry_run=not settings.send)


# ---------------------------------------------------------------- the clock (R14)

def resolve_now(settings: Settings, transport: Transport | None = None, wall: Callable[[], float] = _time.time) -> float:
    """The time a pass plans with. VOL_CLOCK=chain takes the latest block's time (a warped fork); the wall clock refuses to
    post when the chain is ahead of it, because a validUntil from the wall clock would already be expired on that chain."""
    if settings.clock == "chain":
        from .sender import http_transport
        block = (transport or http_transport(settings.rpc_url))("eth_getBlockByNumber", ["latest", False])
        return float(int(str(block["timestamp"]), 16))
    now = wall()
    if settings.rpc_url:
        from .sender import http_transport
        block = (transport or http_transport(settings.rpc_url))("eth_getBlockByNumber", ["latest", False])
        ahead = int(str(block["timestamp"]), 16) - now
        if ahead > CLOCK_SKEW_LIMIT_S:
            raise ClockError(f"the chain is {int(ahead)} s ahead of the wall clock (a warped fork); "
                             "set VOL_CLOCK=chain to plan against the block time")
    return now


# ---------------------------------------------------------------- the sigma computation

@dataclass
class Computation:
    market: Market
    sigma_fast: float = 0.0
    sigma_slow: float = 0.0
    sigma_rv: float = 0.0
    floor: float = 0.0
    hat: float = 0.0              # max(sigma_rv x markup, floor)
    sigma: float = 0.0            # after the event bumps
    event: dict = field(default_factory=dict)   # terms of each bump, for `explain`
    block: tuple[int, int] = (0, 0)
    flags: list[str] = field(default_factory=list)
    alerts: list[tuple[str, dict]] = field(default_factory=list)

    @property
    def target_bps(self) -> int:
        return to_bps(self.sigma)


def compute_key(mk: Market, now: float, store: Store, history: History) -> Computation | None:
    """sigma for one market, or None when its prices are missing or stale (then it posts nothing and the old post keeps
    pricing: a stale input never produces a lower sigma)."""
    comp = Computation(mk, floor=floor_for(mk.key))
    since = now - LOOKBACK_DAYS * 86_400
    legs = [store.prices(leg, "0x" + market_key(leg).hex(), since) for leg in mk.legs]
    for leg, ticks in zip(mk.legs, legs):
        if not ticks:
            comp.alerts.append(("no_prices", {"leg": leg}))
            return _skip(comp)
        age = now - ticks[-1].ts
        if age > MAX_TICK_AGE_S:
            comp.alerts.append(("stale_prices", {"leg": leg, "age_s": int(age // 600) * 600, "limit_s": MAX_TICK_AGE_S}))
            return _skip(comp)

    if mk.is_pair:
        bars_a, bars_b = build_bars(mk.kind, legs[0]), build_bars(mk.kind, legs[1])
        bars = ratio_bars(bars_a, bars_b)
        excluded = bars_a.excluded_extended + bars_b.excluded_extended
    else:
        bars = build_bars(mk.kind, legs[0])
        excluded = bars.excluded_extended
    if excluded:
        comp.flags.append(f"extended_hours_excluded:{excluded}")
    comp.sigma_fast = sigma_scale(bars, HALF_LIFE_FAST_DAYS)
    comp.sigma_slow = sigma_scale(bars, HALF_LIFE_SLOW_DAYS)
    comp.sigma_rv = max(comp.sigma_fast, comp.sigma_slow)
    if len(bars.returns) < bars.bars_per_day:
        comp.flags.append("insufficient_bars")
    comp.hat = sigma_hat(comp.sigma_rv, mk.key)
    comp.sigma = comp.hat

    if mk.kind == "equity" and not mk.is_pair:
        _earnings_bump(comp, now, store, history)
        _weekend_bump(comp, now, history)
    return comp


def _skip(comp: Computation) -> Computation:
    comp.sigma = 0.0
    comp.flags.append("skipped")
    return comp


def _earnings_bump(comp: Computation, now: float, store: Store, history: History) -> None:
    mk = comp.market
    now_s = int(now)
    when = datetime.fromtimestamp(now_s, timezone.utc)
    rows = store.earnings(mk.key) + [r for r in history.overrides if r.symbol == mk.key]
    dec = reconcile(mk.key, rows, when)
    comp.alerts += dec.alerts
    cands = [(dec.report_date, dec.session)] if dec.status == "confirmed" and dec.report_date else dec.candidates
    best = comp.sigma
    for report_date, session in cands:
        report_ts, lo, hi = report_times(report_date, session)
        if hi < now_s:
            continue
        e, e_flags = earnings_move(mk.key, history.moves.get(mk.key, []))
        w = earnings_weight(report_ts, now_s)
        sigma_c = add_event_variance(comp.hat, e, EVENT_TAU_EARNINGS_S, w)
        if dec.status == "confirmed":
            from .config import EARNINGS_LOOKAHEAD_DAYS
            if lo - now_s <= EARNINGS_LOOKAHEAD_DAYS * 86_400:
                comp.block = block_window(lo, hi, now_s)
        if sigma_c > best:
            best = sigma_c
            comp.event["earnings"] = {"date": report_date.isoformat(), "session": session, "E": e, "w": w,
                                      "tau_s": EVENT_TAU_EARNINGS_S, "report_ts": report_ts}
            comp.flags += e_flags + ["earnings_bump"]
    comp.sigma = best
    if dec.force_block:
        comp.block = dec.force_block
        comp.flags.append(f"earnings_{dec.status}")


def _weekend_bump(comp: Computation, now: float, history: History) -> None:
    run = closed_run_now(datetime.fromtimestamp(int(now), timezone.utc))
    if run is None:
        return
    elapsed, length = run
    w = weekend_weight(elapsed)
    if w <= 0:
        return
    g, g_flags = weekend_move(comp.market.key, history.weekend.get(comp.market.key, []))
    comp.sigma = add_event_variance(comp.sigma, g, length, w)
    comp.event["weekend"] = {"G": g, "w": w, "tau_s": length, "elapsed_s": elapsed}
    comp.flags += g_flags + ["weekend_bump"]


# ---------------------------------------------------------------- planning

def _alert(store: Store, mk: Market, kind: str, detail: dict, now_s: float) -> None:
    if store.write_alert(mk.hex, kind, {"key": mk.key, **detail}, now_s):
        log.warning("alert %s %s %s", mk.key, kind, detail)


def worth_posting(sigma_bps: int, block: tuple[int, int], state: ChainState, validity_s: int, now_s: int) -> bool:
    """Post only on a real change (1% relative), a changed buy block, or when the last post is inside 25% of its validity."""
    if state.posted_at == 0:
        return True
    if abs(sigma_bps - state.sigma_bps) / max(state.sigma_bps, 1) >= MIN_RELATIVE_CHANGE:
        return True
    old = (state.buy_block_from, state.buy_block_to)
    if bool(block[1]) != bool(old[1]) or (block[1] and abs(block[1] - old[1]) >= 3_600):
        return True
    return state.valid_until - now_s < RENEW_FRACTION * validity_s


def plan_key(mk: Market, now: float, settings: Settings, store: Store, history: History, oracle: Oracle,
             force: bool = False) -> Intent | None:
    now_s = int(now)
    comp = compute_key(mk, now, store, history)
    if comp is None:
        return None
    for kind, detail in comp.alerts:
        _alert(store, mk, kind, detail, now_s)
    if "skipped" in comp.flags:
        return None

    state = oracle.state(mk.hex)
    interval = max(settings.min_post_interval_s, MIN_POST_INTERVAL_S)
    if state.posted_at and now_s < state.posted_at + interval:
        log.info("%s rate-limited until %d, skipping", mk.key, state.posted_at + interval)
        return None

    floor_bps, ceiling_bps = oracle.bounds(mk.hex, now)
    ceiling_bps = bounds_ceiling(ceiling_bps, mk.key in RACE_MARKETS)
    prior = state.sigma_bps if state.posted_at else None
    target = comp.target_bps
    sigma_bps, step_flags = clamp_step(target, prior, floor_bps, ceiling_bps)
    flags = comp.flags + step_flags
    block = comp.block
    if block[1] and block[1] - block[0] > 3 * 86_400:
        block = (block[0], block[0] + 3 * 86_400)
    if not force and not worth_posting(sigma_bps, block, state, settings.validity_s, now_s):
        return None
    valid_until = now_s + min(settings.validity_s, settings.max_validity_s - 60)
    valid_until = max(valid_until, now_s + MIN_VALIDITY_S + 60)
    return Intent(market=mk.hex, key=mk.key, sigma_bps=sigma_bps, buy_block_from=block[0], buy_block_to=block[1],
                  valid_until=valid_until, nonce=state.nonce + 1, status="planned", flags=flags, created_at=float(now_s))


def plan_pass(now: float, settings: Settings, store: Store, history: History, oracle: Oracle | None = None,
              force: bool = False) -> list[Intent]:
    """One Intent per market worth posting. Pure given its inputs apart from alert rows; never signs or sends."""
    oracle = oracle or make_oracle(settings, store)
    waiting = {i.market for i in store.pending_intents() if now - i.created_at <= PENDING_TTL_S}
    out: list[Intent] = []
    for mk in listed(settings):
        if mk.hex in waiting:
            log.info("%s has a post waiting for its receipt, skipping", mk.key)
            continue
        intent = plan_key(mk, now, settings, store, history, oracle, force)
        if intent is not None:
            out.append(intent)
    return out


# ---------------------------------------------------------------- send and reconcile

def reconcile_pending(store: Store, sender: Sender, now_s: float) -> None:
    """Resolve posts that were broadcast without a receipt. A sent post with no receipt after 15 minutes is `dropped`
    (and so replanned); only a mined, successful post becomes `accepted`."""
    for i in store.pending_intents():
        verdict = sender.confirm(i.tx_hash) if i.tx_hash else None
        if verdict is not None:
            store.mark_intent(i.id or 0, verdict, i.tx_hash)
            if verdict == "rejected":
                store.write_alert(i.market, "post_reverted", {"key": i.key, "nonce": i.nonce, "tx": i.tx_hash}, now_s)
        elif now_s - i.created_at > PENDING_TTL_S:
            store.mark_intent(i.id or 0, "dropped", i.tx_hash)
            store.write_alert(i.market, "post_dropped", {"key": i.key, "nonce": i.nonce, "tx": i.tx_hash}, now_s)


def run_pass(now: float, settings: Settings, store: Store, sender: Sender, history: History, oracle: Oracle | None = None,
             force: bool = False) -> list[Intent]:
    """Plan, sign and record (and with VOL_SEND=1 send) one pass. Returns the intents written."""
    if settings.send:
        reconcile_pending(store, sender, now)
    intents = plan_pass(now, settings, store, history, oracle, force)
    if intents and not (settings.signer_key and settings.oracle_address):
        raise RuntimeError("a signer (VOL_SIGNER_KEYSTORE) and VOL_ORACLE_ADDRESS are required to sign")
    for it in intents:
        post = VolPost(bytes.fromhex(it.market[2:]), it.sigma_bps, it.buy_block_from, it.buy_block_to, it.valid_until, it.nonce)
        signed = sign_post(post, settings.chain_id, settings.oracle_address, settings.signer_key)
        it.digest, it.signature = "0x" + signed.digest.hex(), "0x" + signed.signature.hex()
        it.status = "planned" if settings.send else "dry_run"
        store.write_intent(it)
        if settings.send:
            result = sender.send(signed)
            store.mark_intent(it.id or 0, result.status, result.tx_hash)
            it.status, it.tx_hash = result.status, result.tx_hash
            if result.status in ("dropped", "rejected"):
                store.write_alert(it.market, "send_failed", {"key": it.key, "error": result.error}, now)
        log.info("%s sigma=%d bps nonce=%d %s flags=%s", it.key, it.sigma_bps, it.nonce, it.status, ",".join(it.flags) or "-")
    return intents


def explain(key: str, now: float, settings: Settings, store: Store, history: History, oracle: Oracle | None = None) -> str:
    """Every term of the formula for one key (the published page walks through the same terms)."""
    mk = resolve(key, dict(settings.market_overrides))
    comp = compute_key(mk, now, store, history)
    lines = [f"key            {mk.key}  market {mk.hex}", f"kind           {mk.kind}"]
    if comp is None or "skipped" in comp.flags:
        lines.append("no fresh prices: " + ", ".join(f"{k} {d}" for k, d in (comp.alerts if comp else [])))
        return "\n".join(lines)
    lines += [f"sigma_fast     {comp.sigma_fast:.4f}  (half-life {HALF_LIFE_FAST_DAYS} d)",
              f"sigma_slow     {comp.sigma_slow:.4f}  (half-life {HALF_LIFE_SLOW_DAYS} d)",
              f"sigma_rv       {comp.sigma_rv:.4f}  = max(fast, slow)",
              f"markup         {MARKUP}",
              f"floor          {comp.floor:.4f}",
              f"sigma_hat      {comp.hat:.4f}  = max(sigma_rv x markup, floor)"]
    for name, t in comp.event.items():
        lines.append(f"{name:<14} " + ", ".join(f"{k}={v}" for k, v in t.items()))
    lines += [f"sigma (final)  {comp.sigma:.4f}  = {comp.target_bps} bps",
              f"buy block      {comp.block[0]} to {comp.block[1]}", f"flags          {','.join(comp.flags) or '-'}"]
    try:
        o = oracle or make_oracle(settings, store)
        st = o.state(mk.hex)
        fl, ce = o.bounds(mk.hex, now)
        v, f = clamp_step(comp.target_bps, st.sigma_bps if st.posted_at else None, fl, ce)
        lines.append(f"oracle         last {st.sigma_bps} bps, bounds {fl}..{ce}, would post {v} bps {','.join(f)}")
    except Exception as exc:  # noqa: BLE001 (explain still prints the formula terms without the chain)
        lines.append(f"oracle         unavailable ({type(exc).__name__})")
    return "\n".join(lines)
