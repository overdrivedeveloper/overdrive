"""R11: dry run is the default; the sender is distinct from the signer; a post with no receipt after 15 minutes is dropped and replanned."""

from vol_engine.config import PENDING_TTL_S, Settings
from vol_engine.engine import plan_pass, reconcile_pending, run_pass
from vol_engine.history import History
from vol_engine.sender import DryRunSender, RpcSender, SendResult, make_sender, encode_post_call, POST_SELECTOR
from vol_engine.signer import VolPost, sign_post, market_key
from vol_engine.store import MemoryStore

from helpers import ANVIL_KEY, ANVIL_KEY_2, CHAIN_ID, ORACLE, FakeOracle, crypto_ticks

import pytest

T0 = 1_760_000_000.0
N = 20 * 288


def make():
    st = MemoryStore()
    st.tick_rows["ETH"] = crypto_ticks(T0, N, 0.6, seed=2)
    return st, T0 + 300 * N - 240


def cfg(**kw):
    return Settings(signer_key=ANVIL_KEY, sender_key=ANVIL_KEY_2, oracle_address=ORACLE, chain_id=CHAIN_ID, keys=("ETH",),
                    rpc_url="http://x", **kw)


class Scripted:
    """A sender whose broadcast always returns 'sent' (a hash, no receipt) until a verdict is set."""

    def __init__(self):
        self.verdicts, self.sent = {}, []

    def send(self, signed):
        self.sent.append(signed)
        return SendResult("sent", f"0x{len(self.sent):064x}")

    def confirm(self, tx_hash):
        return self.verdicts.get(tx_hash)


def test_dry_run_default():
    assert isinstance(make_sender(Settings()), DryRunSender)
    assert isinstance(make_sender(Settings.from_env({"VOL_SEND": "yes"})), DryRunSender)
    st, now = make()
    out = run_pass(now, cfg(), st, DryRunSender(), History(), FakeOracle(), force=True)
    assert [i.status for i in out] == ["dry_run"] and all(i.tx_hash is None for i in out)
    with pytest.raises(RuntimeError, match="VOL_SEND=1"):
        RpcSender(ORACLE, 1, ANVIL_KEY_2, lambda m, p: None)
    with pytest.raises(RuntimeError, match="sender wallet"):
        make_sender(Settings(send=True, rpc_url="http://x", oracle_address=ORACLE))


def test_pending_ttl_replans():
    st, now = make()
    s, oracle, sender = cfg(send=True), FakeOracle(), Scripted()
    first = run_pass(now, s, st, sender, History(), oracle, force=True)[0]
    assert first.status == "sent" and len(sender.sent) == 1
    # no receipt yet and inside the TTL: the key waits, nothing new is signed
    assert run_pass(now + 60, s, st, sender, History(), oracle, force=True) == [] and len(sender.sent) == 1
    # 15 minutes without a receipt: dropped, and the same key is planned again with the same nonce (the chain never saw it)
    later = now + PENDING_TTL_S + 60
    from vol_engine.bars import Tick   # keep the price rows fresh
    st.tick_rows["ETH"].append(Tick(later - 30, st.tick_rows["ETH"][-1].price, "REGULAR"))
    out = run_pass(later, s, st, sender, History(), oracle, force=True)
    assert st.intents[0].status == "dropped" and any(a["kind"] == "post_dropped" for a in st.alerts)
    assert len(out) == 1 and out[0].nonce == first.nonce and len(sender.sent) == 2
    # a receipt turns it accepted
    sender.verdicts[out[0].tx_hash] = "accepted"
    reconcile_pending(st, sender, later + 5)
    assert st.intents[1].status == "accepted"


def test_revert_marks_rejected_and_failed_send_is_dropped():
    st, now = make()
    sender = Scripted()
    run_pass(now, cfg(send=True), st, sender, History(), FakeOracle(), force=True)
    sender.verdicts[st.intents[0].tx_hash] = "rejected"
    reconcile_pending(st, sender, now + 10)
    assert st.intents[0].status == "rejected" and st.alerts[-1]["kind"] == "post_reverted"

    class Broke(Scripted):
        def send(self, signed):
            return SendResult("dropped", error="insufficient funds")

    st2, now2 = make()
    out = run_pass(now2, cfg(send=True), st2, Broke(), History(), FakeOracle(), force=True)
    assert out[0].status == "dropped" and st2.alerts[-1]["kind"] == "send_failed"


def test_call_data_layout():
    post = VolPost(market_key("ETH"), 5000, 0, 0, 2_000_000_000, 3)
    signed = sign_post(post, CHAIN_ID, ORACLE, ANVIL_KEY)
    data = encode_post_call(signed)
    assert data[:4] == POST_SELECTOR and data[4:36] == post.market
    assert data[4:36] == post.market and signed.signature in data
