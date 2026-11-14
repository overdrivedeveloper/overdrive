"""Markets the engine posts: names (feeds.json symbols) and pair gears (A over B), each with its bytes32 market key."""

from __future__ import annotations

from dataclasses import dataclass

from .config import Settings, is_pair, kind_of
from .signer import market_key, pair_key


@dataclass(frozen=True)
class Market:
    key: str          # "NVDA" or "NVDA/AMD"
    market: bytes     # keccak256(bytes(symbol)) or keccak256(abi.encode(marketA, marketB))
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
    if overrides and key in overrides:
        market = bytes.fromhex(overrides[key][2:])
    elif len(legs) == 2:
        market = pair_key(market_key(legs[0]), market_key(legs[1]))
    else:
        market = market_key(key)
    return Market(key, market, legs, kind_of(key))


def listed(settings: Settings) -> list[Market]:
    ov = dict(settings.market_overrides)
    return [resolve(k, ov) for k in settings.keys]
