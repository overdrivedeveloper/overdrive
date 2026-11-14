"""Senders for ODVolOracle.post. Dry-run by default; a real send needs VOL_SEND=1 plus an RPC and a gas wallet that is not the signer."""

from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable, Protocol

from eth_abi import encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

from .config import Settings
from .signer import SignedPost

POST_SIGNATURE = "post((bytes32,uint64,uint64,uint64,uint64,uint64),bytes)"
POST_SELECTOR = keccak(text=POST_SIGNATURE)[:4]
POST_TUPLE = "(bytes32,uint64,uint64,uint64,uint64,uint64)"


@dataclass(frozen=True)
class SendResult:
    status: str  # dry_run | sent (broadcast, no receipt yet) | accepted (receipt, status 1) | rejected (reverted) | dropped (never broadcast)
    tx_hash: str | None = None
    error: str | None = None


class Sender(Protocol):
    def send(self, signed: SignedPost) -> SendResult: ...

    def confirm(self, tx_hash: str) -> str | None:
        """'accepted' (mined, status 1), 'rejected' (mined, reverted) or None (no receipt yet)."""
        ...


def encode_post_call(signed: SignedPost) -> bytes:
    return POST_SELECTOR + encode([POST_TUPLE, "bytes"], [signed.post.as_tuple(), signed.signature])


class DryRunSender:
    def send(self, signed: SignedPost) -> SendResult:
        return SendResult("dry_run")

    def confirm(self, tx_hash: str) -> str | None:
        return None


Transport = Callable[[str, list], object]

# Public RPCs behind a CDN answer 403 to urllib's default "Python-urllib/x.y" User-Agent.
USER_AGENT = "overdrive-vol-engine/1"


def http_transport(url: str) -> Transport:
    def call(method: str, params: list) -> object:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 (operator-configured RPC URL)
            payload = json.loads(resp.read())
        if "error" in payload:
            raise RuntimeError(f"rpc {method} failed: {payload['error'].get('message', 'error')}")
        return payload["result"]

    return call


GAS_PRICE_HEADROOM_PCT = 150


class RpcSender:
    """Signs a legacy transaction with the gas key and submits it. Only constructible with allow_send=True."""

    def __init__(self, oracle: str, chain_id: int, gas_key: str, transport: Transport, allow_send: bool = False,
                 confirm_wait_s: float = 4.0, sleep: Callable[[float], None] = time.sleep) -> None:
        if not allow_send:
            raise RuntimeError("RpcSender refuses to send unless VOL_SEND=1")
        self._oracle = to_checksum_address(oracle)
        self._chain_id = chain_id
        self._key = gas_key
        self._rpc = transport
        self._from = Account.from_key(gas_key).address
        self._confirm_wait_s = confirm_wait_s
        self._sleep = sleep

    def confirm(self, tx_hash: str) -> str | None:
        try:
            receipt = self._rpc("eth_getTransactionReceipt", [tx_hash])
        except Exception:  # noqa: BLE001 (an RPC hiccup is "no receipt yet", never a verdict)
            return None
        if not receipt or not isinstance(receipt, dict):
            return None
        return "accepted" if int(str(receipt.get("status", "0x0")), 16) == 1 else "rejected"

    def send(self, signed: SignedPost) -> SendResult:
        try:
            data = encode_post_call(signed)
            nonce = int(self._rpc("eth_getTransactionCount", [self._from, "pending"]), 16)
            gas_price = int(self._rpc("eth_gasPrice", []), 16) * GAS_PRICE_HEADROOM_PCT // 100
            call = {"from": self._from, "to": self._oracle, "data": "0x" + data.hex()}
            gas = int(int(self._rpc("eth_estimateGas", [call]), 16) * 1.25)
            tx = {"nonce": nonce, "gasPrice": gas_price, "gas": gas, "to": self._oracle, "value": 0,
                  "data": data, "chainId": self._chain_id}
            raw = Account.sign_transaction(tx, self._key).raw_transaction
            tx_hash = self._rpc("eth_sendRawTransaction", ["0x" + bytes(raw).hex()])
            # A hash is not an accepted post. Wait briefly for the receipt; otherwise the engine reconciles it later.
            waited = 0.0
            status = self.confirm(str(tx_hash))
            while status is None and waited < self._confirm_wait_s:
                self._sleep(0.5)
                waited += 0.5
                status = self.confirm(str(tx_hash))
            return SendResult(status or "sent", str(tx_hash))
        except Exception as exc:  # never broadcast: a reverting gas estimate is rejected; a short wallet or a dead RPC is dropped and replanned
            msg = type(exc).__name__ + ": " + str(exc)[:200]
            return SendResult("rejected" if "revert" in msg.lower() else "dropped", error=msg)


def make_sender(settings: Settings, transport: Transport | None = None,
                sleep: Callable[[float], None] = time.sleep) -> Sender:
    if not settings.send:
        return DryRunSender()
    if not (settings.rpc_url and settings.oracle_address and settings.sender_key):
        raise RuntimeError("VOL_SEND=1 needs VOL_RPC_URL, VOL_ORACLE_ADDRESS and a sender wallet")
    return RpcSender(settings.oracle_address, settings.chain_id, settings.sender_key,
                     transport or http_transport(settings.rpc_url), allow_send=True, sleep=sleep)
