"""One JSON line per event on stderr (stdout stays for machine output). No secrets are ever passed in."""

from __future__ import annotations

import json
import sys

SECRET_KEYS = ("password", "secret", "key", "token", "url")


def log(event: str, **fields: object) -> None:
    safe = {k: ("<redacted>" if any(s in k.lower() for s in SECRET_KEYS) else v) for k, v in fields.items()}
    print(json.dumps({"event": event, **safe}, sort_keys=True, default=str), file=sys.stderr)
