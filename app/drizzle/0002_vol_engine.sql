-- Vol engine (todo 15). The engine reads `prices`, `vol_posts` and `earnings_dates`; it writes only these two tables.
-- Drizzle migration 0002; 0000/0001 come from the indexer lane. `earnings_dates` (source 'calendar') is written by the keeper.
CREATE TABLE IF NOT EXISTS earnings_dates (
  symbol text NOT NULL,
  report_date date NOT NULL,
  session text NOT NULL DEFAULT 'unknown',          -- pre | post | unknown
  source text NOT NULL,                             -- calendar | company_ir
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, source, report_date)
);

CREATE TABLE IF NOT EXISTS vol_post_intents (
  id bigserial PRIMARY KEY,
  market text NOT NULL,                             -- 0x bytes32, keccak256(symbol) or keccak256(abi.encode(a, b))
  key text NOT NULL DEFAULT '',                     -- 'NVDA' or 'NVDA/AMD', for people
  sigma_bps bigint NOT NULL,
  buy_block_from timestamptz,
  buy_block_to timestamptz,
  valid_until timestamptz NOT NULL,
  nonce bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','dry_run','sent','accepted','dropped','rejected')),
  tx_hash text,
  flags text[] NOT NULL DEFAULT '{}',
  digest text NOT NULL DEFAULT '',
  signature text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vol_post_intents_market_idx ON vol_post_intents (market, created_at DESC);
CREATE INDEX IF NOT EXISTS vol_post_intents_pending_idx ON vol_post_intents (status) WHERE status IN ('planned','sent');

CREATE TABLE IF NOT EXISTS vol_alerts (
  id bigserial PRIMARY KEY,
  market text NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  repeated_at timestamptz
);
CREATE INDEX IF NOT EXISTS vol_alerts_market_kind_idx ON vol_alerts (market, kind, id DESC);
