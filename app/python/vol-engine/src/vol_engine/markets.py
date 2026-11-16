"""Markets the engine posts: names (feeds.json symbols) and pair gears (A over B), each with its bytes32 market key."""

from __future__ import annotations

from dataclasses import dataclass

from .config import Settings, is_pair, kind_of
from .signer import market_key, pair_key


@dataclass(frozen=True)
class Market:
    key: str          # "NVDA" or "NVDA/AMD"
    market: bytes     # bytes32(bytes(symbol)) or keccak256(abi.encode(idA, idB))
    legs: tuple[str, ...]
    kind: str         # equity | crypto

    @property
    def hex(self) -> str:
        return "0x" + self.market.hex()

    @property
    def is_pair(self) -> bool:
        return len(self.legs) == 2


def resolve(key: str, overrides: dict[str, str] | None = None) -> Market:
    key = key.upper()
    legs = tuple(key.split("/")) if is_pair(key) else (key,)
    ov = overrides or {}
    if key in ov:
        market = bytes.fromhex(ov[key][2:])
    elif len(legs) == 2:
        market = pair_key(leg_id(legs[0], ov), leg_id(legs[1], ov))
    else:
        market = market_key(key)
    return Market(key, market, legs, kind_of(key))


def leg_id(symbol: str, overrides: dict[str, str] | None = None) -> bytes:
    """One name's market id: its VOL_KEYS override when there is one, else the deployment's bytes32 of the symbol."""
    ov = overrides or {}
    return bytes.fromhex(ov[symbol][2:]) if symbol in ov else market_key(symbol)


def check_deployment(keys: tuple[str, ...], overrides: dict[str, str], record: dict) -> list[str]:
    """Problems between the engine's keys and a deployment record (app/deployments/<chain id>.json); empty means every
    market and pair gear the deployment reads is posted under the exact id its oracle reads. Used by `vol-engine
    check-keys` at deploy time so a key scheme drift cannot pass silently."""
    problems: list[str] = []
    ids: dict[str, bytes] = {}
    for m in record.get("markets") or []:
        sym, mid = str(m.get("symbol", "")), str(m.get("id", ""))
        if len(mid) != 66 or not mid.startswith("0x"):
            problems.append(f"{sym or '?'}: deployment id {mid!r} is not a 0x bytes32")
            continue
        ids[sym.upper()] = bytes.fromhex(mid[2:])
    want: dict[str, bytes] = dict(ids)
    for g in record.get("gears") or []:
        a, b = str(g.get("marketA") or "").upper(), str(g.get("marketB") or "").upper()
        if a and b and a in ids and b in ids:
            want[f"{a}/{b}"] = pair_key(ids[a], ids[b])
    mine: dict[str, bytes] = {}
    for k in keys:
        try:
            mine[k.upper()] = resolve(k, overrides).market
        except ValueError as exc:
            problems.append(f"{k}: {exc}")
    for k, expected in want.items():
        if k not in mine:
            problems.append(f"{k}: the deployment reads it but the engine does not post it (add it to VOL_KEYS)")
        elif mine[k] != expected:
            problems.append(f"{k}: engine key 0x{mine[k].hex()} but the deployment reads 0x{expected.hex()}")
    return problems


def listed(settings: Settings) -> list[Market]:
    ov = dict(settings.market_overrides)
    return [resolve(k, ov) for k in settings.keys]
