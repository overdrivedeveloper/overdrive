"""The shipped env.example starts safe: no send, no key."""

import re
from pathlib import Path

from vol_engine.config import Settings
from vol_engine.sender import DryRunSender, make_sender

EXAMPLE = Path(__file__).resolve().parents[1] / "env.example"


def example_env() -> dict[str, str]:
    env = {}
    for line in EXAMPLE.read_text().splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if m:
            env[m.group(1)] = m.group(2)
    return env


def test_example_does_not_enable_sending_or_carry_a_key():
    env = example_env()
    assert env["VOL_SEND"] == "0" and "VOL_SIGNER_KEY" not in env and "VOL_SENDER_KEY" not in env
    s = Settings.from_env({k: v for k, v in env.items() if "KEYSTORE" not in k})   # the keystore paths are the operator's
    assert s.send is False and s.signer_key == "" and s.sender_key == ""
    assert isinstance(make_sender(s), DryRunSender)
    assert s.production is True and s.clock == "wall"
