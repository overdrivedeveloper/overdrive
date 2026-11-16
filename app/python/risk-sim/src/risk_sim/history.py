"""Free public candles into data/*.csv (no key). Binance public market data for the crypto cascade, Yahoo chart for daily bars."""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STOCKS = ("TSLA", "NVDA", "SPY", "QQQ", "AAPL", "MSFT", "META", "AMZN", "COIN", "MSTR", "PLTR", "AMD", "HOOD")
CRYPTO = {"ETH": ("ETHUSDT", "ETH-USD"), "BTC": ("BTCUSDT", "BTC-USD")}
OCT10_START = datetime(2025, 10, 10, tzinfo=timezone.utc)
OCT10_END = datetime(2025, 10, 11, tzinfo=timezone.utc)
UA = {"User-Agent": "Mozilla/5.0 (risk-sim history fetch)"}


def _get(url: str, retries: int = 4) -> object:
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(1.5 * 2**i)
    raise RuntimeError("unreachable")


def fetch_oct10(out: Path) -> int:
    rows = []
    for sym, (binance, _) in CRYPTO.items():
        url = ("https://data-api.binance.vision/api/v3/klines?symbol=%s&interval=5m&startTime=%d&endTime=%d&limit=1000"
               % (binance, int(OCT10_START.timestamp() * 1000), int(OCT10_END.timestamp() * 1000) - 1))
        for k in _get(url):  # type: ignore[union-attr]
            ts = datetime.fromtimestamp(k[0] / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            rows.append((sym, ts, k[1], k[2], k[3], k[4]))
    _write(out, ("symbol", "ts", "open", "high", "low", "close"), rows)
    return len(rows)


def fetch_daily(out: Path, since: datetime, until: datetime) -> int:
    rows = []
    names = [(s, s) for s in STOCKS] + [(s, y) for s, (_, y) in CRYPTO.items()]
    for sym, ysym in names:
        url = ("https://query1.finance.yahoo.com/v8/finance/chart/%s?period1=%d&period2=%d&interval=1d&events=split"
               % (ysym, int(since.timestamp()), int(until.timestamp())))
        res = _get(url)["chart"]["result"][0]  # type: ignore[index]
        q = res["indicators"]["quote"][0]
        for i, t in enumerate(res["timestamp"]):
            vals = [q[k][i] for k in ("open", "high", "low", "close")]
            if any(v is None for v in vals):
                continue
            d = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
            rows.append((sym, d, *("%.6f" % v for v in vals)))
        time.sleep(0.4)
    rows.sort(key=lambda r: (r[0], r[1]))
    _write(out, ("symbol", "date", "open", "high", "low", "close"), rows)
    return len(rows)


def _write(path: Path, header: tuple, rows: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join([",".join(header)] + [",".join(str(x) for x in r) for r in rows]) + "\n")


def fetch_all(data_dir: Path = DATA_DIR) -> dict:
    now = datetime.now(timezone.utc)
    since = datetime(now.year - 2, now.month, 1, tzinfo=timezone.utc)
    return {"oct10_5m": fetch_oct10(data_dir / "oct10_2025_5m.csv"), "daily": fetch_daily(data_dir / "daily.csv", since, now)}
