# risk-sim

Nightly stress of the Governor book. It replays eight scenarios, compares them with the on-chain stress rule, and recommends caps so the worst
stress loss stays at or below 15% of Governor equity (`RISK_MAX_LOSS_BPS`, 1500). It recommends only: it holds no keys, has no chain write
access, and a cap changes only through the 48 h timelock.

## Run
```
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.lock && pip install --no-build-isolation --no-deps -e .
pytest -q
risk-sim run --nightly                                   # reads the indexer schema (todo 13), writes risk_runs, risk_scenario_results, risk_caps
risk-sim run --scenario single_stock_minus_18_7 --from-fixture tests/fixtures/book_small.json
risk-sim caps --equity 500000                            # cap table for an assumed equity
risk-sim fetch-history                                   # free public candles into data/ (Binance market data, Yahoo daily bars; no key)
```

## Env
`DATABASE_URL` (read role; the book is read on a connection the server holds read-only), `RISK_WRITE_DATABASE_URL` (write role, defaults to
`DATABASE_URL`), `RISK_MAX_LOSS_BPS` (1500), `RISK_HEDGE_LAG_SECONDS` (default `HEDGER_INTERVAL_SECONDS`, 1800), `RISK_OUT_DIR` (out),
`RISK_MAX_BOOK_AGE_SECONDS` (900), `TELEGRAM_OUTBOX` (a file the crank posts from), `RISK_SEED`, `RISK_ONCHAIN_SHOCK_BPS`
(placeholder for the Governor's stress shock s until contract 05a lands). The hedger band, hard band, cycle and cooldown are read from the
same `HEDGER_*` variables the hedger uses.

## Model in one paragraph
Governor P&L on a path = hedge P&L - change in value of Governor-backed gears + toll income - slippage and fees. Gear values are exact
(`NF x (P_t/P_0)^p`), never a Taylor expansion. Tokens minted against backer vaults are excluded (they hit the vault). The hedge is the real
policy (band, hard band, interval, cooldown, venue up or down), not a perfect hedge. The cap plan is evaluated with every gear at its cap
and the hedger band sized to the book, so losses scale linearly and the plan is monotone in equity.

## Assumptions to confirm (each is printed in the report)
- 31 Jan 2026 has no meaning in the spec: it replays the measured worst 1-day and 3-day moves within +-3 days (TODO for the owner to name it).
- The 10 Oct 2025 venue outage is assumed 30 minutes around the ETH low; stocks stay flat in that scenario.
- The on-chain shock s is a placeholder (15%) until `IODGovernor.stressLoss` exists; `onchain_stress` follows the rule in the todo.
- Posted-sigma lag: 25% per post, one post every 6 hours.
