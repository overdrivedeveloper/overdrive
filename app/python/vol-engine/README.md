# vol-engine

Computes sigma for every listed market (a name such as `NVDA`, or a pair gear such as `NVDA/AMD`), signs an EIP-712 `VolPost`
and, only when told to, sends it to `ODVolOracle`. The formula is published in [FORMULA.md](FORMULA.md); a test keeps the page and
`src/vol_engine/config.py` equal.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements-dev.lock && pip install --no-deps --no-build-isolation -e .
pytest -q
vol-engine post --once            # one pass: signs and records an intent per key with fresh prices; sends nothing
vol-engine post --loop --interval 300
vol-engine explain NVDA           # every term of the formula for one key
```

`VOL_SEND` must be exactly `1` to send. Without it every intent is stored `dry_run`. The environment is in `env.example`; an
unknown `VOL_*` name refuses to start, `NODE_ENV=production` accepts keystores only, and the gas wallet (`VOL_SENDER_*`) must
differ from the signer (`VOL_SIGNER_*`).

## Data

- Reads `prices` (the indexer; `underlying` is the symbol), `vol_posts` and `earnings_dates` (source `calendar`; the keeper fills
  it). The company-published dates (`company_ir`) come from `app/src/config/earnings-overrides.json`.
- Past report moves and weekend gaps come from `app/src/config/vol-moves.json` and `vol-weekend.json`
  (`bun run scripts/seed-vol-history.ts` in `app/`); short history falls back to flagged defaults.
- Writes only `vol_post_intents` and `vol_alerts` (migration `app/drizzle/0002_vol_engine.sql`). The reader connection is
  read-only at the server.

## Intent status

`planned` (signed, about to send), `dry_run`, `sent` (broadcast, no receipt), `accepted` (mined, status 1), `rejected` (reverted),
`dropped` (never broadcast, or no receipt after 15 minutes; the key is planned again).

## Tests

Postgres tests start a throwaway cluster on port 5512 (database `overdrive_lane15`); the anvil tests use port 8625 and need
`forge build` output in `contracts/out`. Both skip when the tools are missing.
