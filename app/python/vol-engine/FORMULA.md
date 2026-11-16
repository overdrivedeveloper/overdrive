# Vol engine formula

The toll is `1/2 x p x (p-1) x sigma^2` per day plus a usage term, so sigma is the price of every convex gear. This page is
the published formula. Every constant in the tables below is read by `tests/test_formula_doc.py` and compared with
`src/vol_engine/config.py`, so the page and the code cannot drift apart. The engine posts one signed sigma per market (a
name or a pair gear); the oracle (`ODVolOracle`) enforces the limits again on chain.

## Inputs

- Bars: 5-minute log returns of the oracle price rows. Equities use regular hours only (extended-hours prints are dropped and
  flagged `extended_hours_excluded`); ETH and BTC use every bar, 24/7. When the feed did not print in a 5-minute bucket, the last
  price is carried forward (feeds update on a 0.5% deviation or a heartbeat).
- Annualisation: 252 days for equities (78 bars a day), 365 for crypto (288 bars a day).

## Steps

1. `sigma_fast`: EWMA of the return variance, half-life 1 day, plus (equities only) an EWMA of the overnight close-to-open variance.
2. `sigma_slow`: the same with a half-life of 5 days.
3. `sigma_hat = max(max(sigma_fast, sigma_slow) x 1.15, floor[key])`.
4. Event bump (equities only, single names): `sigma_eff^2 = sigma^2 x R^w` with `R = 1 + E^2 / (tau x sigma^2)`, tau in years.
   `E` is the median absolute 1-day move over the last 8 reports; the report weight `w` rises linearly from 0 to 1 over the 6 hours
   before the report and stays 1 until the buy block ends. Only when two independent sources agree within one day is a date used.
   The weekend bump is the same with `G` (90th percentile of Friday close to Monday open moves), tau equal to the length of the
   closed run, applied only during the closed run, with `w` rising over its first 6 hours. The bump is folded into `sigmaBps`.
5. Buy block: `buyBlockFrom = report - 60 min`, `buyBlockTo = report + 30 min`, from now or later, at most 3 days long.
   Two sources that disagree, or one source missing, inside 16 days: `now` to `now + 24 h`, an alert, and the higher reading posts.
6. Pairs (A over B): the same two scales on the 5-minute log of price A over price B, same markup, floor for pairs.
7. Guards: never outside the oracle's `bounds(market)` (Race markets: ceiling at most 4,000 bps); never more than 25% from the last
   accepted post (the first post is exempt), so a larger move is reached in steps and flagged `ramped`.
8. Cadence: post on a real change (1% relative), a changed buy block, or when the last post has under 25% of its validity left;
   never faster than the oracle's minimum interval; `validUntil` between 5 minutes and 2 hours ahead (default 1 hour); the nonce is
   read from `lastNonce(market)`.
9. Freshness: prices older than 25 minutes produce no post for that key and a `stale_prices` alert; the previous post keeps pricing.
   A stale input never produces a lower sigma.

## Constants

| name | value |
|---|---|
| markup | 1.15 |
| half_life_fast_days | 1.0 |
| half_life_slow_days | 5.0 |
| equity_days_per_year | 252 |
| crypto_days_per_year | 365 |
| bar_seconds | 300 |
| max_step_bps | 2500 |
| min_post_interval_s | 30 |
| min_validity_s | 300 |
| max_validity_s | 7200 |
| default_validity_s | 3600 |
| max_buy_block_s | 259200 |
| min_relative_change | 0.01 |
| renew_fraction | 0.25 |
| max_tick_age_s | 1500 |
| pending_ttl_s | 900 |
| earnings_lookahead_days | 16 |
| earnings_moves_used | 8 |
| min_earnings_moves | 4 |
| min_weekend_samples | 26 |
| weekend_percentile | 90 |
| block_before_s | 3600 |
| block_after_s | 1800 |
| unconfirmed_block_s | 86400 |
| event_tau_earnings_s | 86400 |
| event_ramp_s | 21600 |
| race_ceiling_bps | 4000 |

## Floors (a proposal for the owner; the final values are a recorded decision before launch)

| name | value |
|---|---|
| floor_crypto | 0.40 |
| floor_index_etf | 0.15 |
| floor_mega | 0.30 |
| floor_retail | 0.45 |
| floor_pair | 0.30 |

ETH and BTC are crypto; SPY and QQQ are index ETFs (decision D22: 15%); NVDA, TSLA, AAPL, MSFT, META, AMZN and AMD are mega-caps;
COIN, MSTR and PLTR are retail favourites; every pair is a pair. The engine's floors sit at or above the oracle's own floor.

## Conservative defaults (used, and flagged, when history is short)

| name | value |
|---|---|
| earnings_move_default | 0.06 |
| earnings_move_default_TSLA | 0.08 |
| earnings_move_default_NVDA | 0.07 |
| weekend_gap_default | 0.04 |
| weekend_gap_default_SPY | 0.02 |
| weekend_gap_default_QQQ | 0.025 |
