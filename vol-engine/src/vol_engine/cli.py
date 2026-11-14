"""vol-engine post --once | --loop, vol-engine explain KEY"""

from __future__ import annotations

import argparse
import dataclasses
import sys
import time

from .config import Settings
from .engine import ClockError, explain, make_oracle, read_constants, resolve_now, run_pass
from .history import History
from .keystore import KeyConfigError
from .logs import configure_logging
from .sender import http_transport, make_sender
from .store import PgStore


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vol-engine")
    sub = parser.add_subparsers(dest="command", required=True)
    post = sub.add_parser("post", help="compute, sign and record (with VOL_SEND=1, send) sigma for every market")
    mode = post.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="one pass, writes an intent for every key that has fresh prices")
    mode.add_argument("--loop", action="store_true", help="repeat; posts only on a real change or near expiry")
    post.add_argument("--interval", type=int, default=300, help="seconds between passes in --loop (default 300)")
    exp = sub.add_parser("explain", help="print every term of the formula for one key, e.g. NVDA or NVDA/AMD")
    exp.add_argument("key")
    args = parser.parse_args(argv)

    try:
        settings = Settings.from_env()
    except (KeyConfigError, ValueError) as exc:  # names variables and paths only, never a key or a password
        print(f"vol-engine: {exc}", file=sys.stderr)
        return 78
    log = configure_logging(settings.secrets())
    if not settings.database_url:
        log.error("DATABASE_URL is required")
        return 2
    rpc = http_transport(settings.rpc_url) if settings.rpc_url else None
    if rpc and settings.oracle_address:
        try:  # the contract's own constants win over the VOL_* fallbacks
            settings = dataclasses.replace(settings, **read_constants(rpc, settings.oracle_address))
            log.info("oracle constants: interval=%ds max_validity=%ds", settings.min_post_interval_s, settings.max_validity_s)
        except Exception:  # noqa: BLE001 (keep the configured values; the contract still enforces its own)
            log.warning("could not read the oracle constants, using the configured values")
    store = PgStore(settings.database_url)
    history = History.from_dir(settings.config_dir)
    try:
        if args.command == "explain":
            print(explain(args.key, resolve_now(settings, rpc), settings, store, history, make_oracle(settings, store, rpc)))
            return 0
        sender = make_sender(settings)
        oracle = make_oracle(settings, store, rpc)
        log.info("starting: keys=%d send=%s", len(settings.keys), "ON" if settings.send else "off (dry-run)")
        while True:
            try:
                run_pass(resolve_now(settings, rpc), settings, store, sender, history, oracle, force=args.once)
            except ClockError as exc:
                log.error("not posting: %s", exc)
                if args.once:
                    return 3
            except Exception:  # noqa: BLE001 (a bad pass must not kill the loop; --once reports it)
                if args.once:
                    raise
                log.exception("pass failed, retrying next interval")
            if args.once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
