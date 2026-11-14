"""End to end against a LOCAL anvil: deploy ODVolOracle, let the engine sign and send, read the posts back. Nothing touches a real network."""

import json


from vol_engine.bars import Tick
from vol_engine.config import Settings
from vol_engine.engine import RpcOracle, plan_pass, read_bounds, read_constants, read_state, resolve_now, run_pass
from vol_engine.guard import contract_rejects
from vol_engine.history import History
from vol_engine.markets import resolve
from vol_engine.sender import http_transport, make_sender
from vol_engine.signer import signer_address
from vol_engine.store import MemoryStore

from conftest import ARTIFACT, cast, needs_anvil
from helpers import ANVIL_KEY, ANVIL_KEY_2, crypto_ticks

pytestmark = needs_anvil
DEV0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
N = 12 * 288


def deploy(chain: str) -> str:
    code = json.loads(ARTIFACT.read_text())["bytecode"]["object"]
    args = cast("abi-encode", "constructor(address,address,address)", DEV0, DEV0, signer_address(ANVIL_KEY))
    out = cast("send", "--rpc-url", chain, "--private-key", ANVIL_KEY, "--create", code + args[2:], "--json")
    return json.loads(out)["contractAddress"]


def chain_now(chain: str) -> int:
    return int(cast("block", "--rpc-url", chain, "--field", "timestamp"))


def advance(chain: str, seconds: int) -> None:
    cast("rpc", "--rpc-url", chain, "evm_increaseTime", str(seconds))
    cast("rpc", "--rpc-url", chain, "evm_mine")


def settings(chain: str, oracle: str, *keys: str) -> Settings:
    return Settings(signer_key=ANVIL_KEY, sender_key=ANVIL_KEY_2, oracle_address=oracle, chain_id=31337, rpc_url=chain, send=True,
                    clock="chain", keys=keys or ("ETH",))


def price_rows(end_ts: float, vol: float, seed: int, shock_at: int = -1, shock: float = 0.0) -> list[Tick]:
    return crypto_ticks(end_ts - 300 * (N - 1), N, vol, seed=seed, shock_at=shock_at, shock=shock)


def test_post_accepted_on_fork(chain):
    oracle = deploy(chain)
    tr = http_transport(chain)
    assert read_constants(tr, oracle) == {"min_post_interval_s": 30, "max_validity_s": 7200}
    s = settings(chain, oracle)
    now = chain_now(chain)
    st = MemoryStore()
    st.tick_rows["ETH"] = price_rows(now - 30, 0.6, seed=4)
    sender = make_sender(s, tr)
    assert resolve_now(s, tr) == now
    out = run_pass(now, s, st, sender, History(), RpcOracle(tr, oracle), force=True)
    assert [i.status for i in out] == ["accepted"]            # a mined, successful receipt, not just a hash
    mk = resolve("ETH")
    state = read_state(tr, oracle, mk.market)
    assert state.sigma_bps == out[0].sigma_bps and state.nonce == 1 and state.valid_until == out[0].valid_until
    # second post after the contract's rate limit, next nonce read from the chain
    advance(chain, 31)
    now2 = chain_now(chain)
    st.tick_rows["ETH"] += [Tick(now2 - 20, st.tick_rows["ETH"][-1].price * 1.02, "REGULAR")]
    out2 = run_pass(now2, s, st, sender, History(), RpcOracle(tr, oracle), force=True)
    assert [i.status for i in out2] == ["accepted"] and out2[0].nonce == 2
    # an immediate third pass is skipped by the engine itself: no tx, no revert
    blk = cast("block-number", "--rpc-url", chain)
    assert run_pass(now2 + 2, s, st, sender, History(), RpcOracle(tr, oracle), force=True) == []
    assert read_state(tr, oracle, mk.market).nonce == 2 and cast("block-number", "--rpc-url", chain) == blk


def test_engine_never_planned_a_rejected_post(chain):
    oracle = deploy(chain)
    tr = http_transport(chain)
    mk = resolve("ETH")
    cast("send", "--rpc-url", chain, "--private-key", ANVIL_KEY, oracle, "setBounds(bytes32,uint64,uint64)",
         "0x" + mk.market.hex(), "4200", "9000")
    assert read_bounds(tr, oracle, mk.market) == (4200, 9000)
    s = settings(chain, oracle)
    sender = make_sender(s, tr)
    st = MemoryStore()
    for step in range(14):
        now = chain_now(chain)
        vol = [0.2, 0.2, 0.9, 0.9, 2.5, 2.5, 0.3, 0.3, 0.3, 1.6, 1.6, 0.2, 0.2, 0.2][step]
        shock = [0, 0, 0.4, 0, 0.6, 0, -0.5, 0, 0, 0.4, 0, -0.4, 0, 0][step]
        st.tick_rows["ETH"] = price_rows(now - 20, vol, seed=100 + step, shock_at=N - 3, shock=float(shock))
        before = read_state(tr, oracle, mk.market)
        out = run_pass(now, s, st, sender, History(), RpcOracle(tr, oracle), force=True)
        assert all(i.status == "accepted" for i in out), [(i.status, i.flags) for i in out]
        for i in out:
            assert 4200 <= i.sigma_bps <= 9000                        # clamped into the oracle's own bounds
            ref = min(max(before.sigma_bps, 4200), 9000)
            if before.posted_at:
                assert abs(i.sigma_bps - ref) * 10_000 <= ref * 2500
            assert read_state(tr, oracle, mk.market).sigma_bps == i.sigma_bps
        advance(chain, 31)
    assert not any(i.status in ("rejected", "dropped") for i in st.intents) and len(st.intents) >= 10
    assert any("ramped" in i.flags for i in st.intents) and any("clamped" in i.flags for i in st.intents)
