-- Plain Postgres 16 (no extensions). Units: USDG raw 6 dp NUMERIC(78,0); NF, index and token amounts WAD NUMERIC(78,0).
CREATE TABLE IF NOT EXISTS gears (
  id text PRIMARY KEY,
  market_a text NOT NULL,
  market_b text,
  underlying text NOT NULL,
  underlying_b text,
  power numeric NOT NULL,
  power_wad numeric(78,0) NOT NULL,
  token text UNIQUE NOT NULL,
  cap_usd numeric(78,0) NOT NULL,
  spread_bps integer NOT NULL,
  status text NOT NULL CHECK (status IN ('active','paused','retired')),
  nf numeric(78,0) NOT NULL DEFAULT 1000000000000000000,
  last_accrual timestamptz,
  listed_block bigint,
  listed_at timestamptz
);
CREATE INDEX IF NOT EXISTS gears_underlying_idx ON gears (underlying);

CREATE TABLE IF NOT EXISTS nf_history (
  gear text NOT NULL,
  ts timestamptz NOT NULL,
  block bigint,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  nf numeric(78,0) NOT NULL,
  toll numeric(78,0) NOT NULL,
  toll_value_usd_wad numeric(78,0),
  sigma_hat numeric(78,0),
  usage numeric(78,0),
  session text,
  PRIMARY KEY (gear, ts, tx_hash, log_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS nf_history_event_uq ON nf_history (tx_hash, log_index);
CREATE INDEX IF NOT EXISTS nf_history_gear_ts_idx ON nf_history (gear, ts DESC);
CREATE INDEX IF NOT EXISTS nf_history_block_idx ON nf_history (block);

CREATE TABLE IF NOT EXISTS backer_vaults (
  id numeric(78,0) PRIMARY KEY,
  owner text NOT NULL,
  gear text NOT NULL,
  collateral numeric(78,0) NOT NULL,
  debt_tokens numeric(78,0) NOT NULL,
  health numeric(78,0),
  status text NOT NULL CHECK (status IN ('open','liquidating','closed')),
  opened_block bigint,
  updated_block bigint
);
CREATE INDEX IF NOT EXISTS backer_vaults_owner_idx ON backer_vaults (owner);
CREATE INDEX IF NOT EXISTS backer_vaults_gear_idx ON backer_vaults (gear);
CREATE INDEX IF NOT EXISTS backer_vaults_health_idx ON backer_vaults (health);
CREATE INDEX IF NOT EXISTS backer_vaults_updated_block_idx ON backer_vaults (updated_block);

CREATE TABLE IF NOT EXISTS governor_ledger (
  ts timestamptz NOT NULL,
  underlying text NOT NULL,
  delta numeric(78,0) NOT NULL,
  gamma numeric(78,0) NOT NULL,
  hedge_delta numeric(78,0) NOT NULL,
  equity numeric(78,0) NOT NULL,
  exit_reserve numeric(78,0) NOT NULL,
  block bigint,
  PRIMARY KEY (ts, underlying)
);
CREATE INDEX IF NOT EXISTS governor_ledger_underlying_ts_idx ON governor_ledger (underlying, ts DESC);
CREATE INDEX IF NOT EXISTS governor_ledger_block_idx ON governor_ledger (block);

CREATE TABLE IF NOT EXISTS fees (
  ts timestamptz NOT NULL,
  gear text,
  kind text NOT NULL,
  amount numeric(78,0) NOT NULL,
  block bigint,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS fees_ts_idx ON fees (ts DESC);
CREATE INDEX IF NOT EXISTS fees_block_idx ON fees (block);

-- shared by every service, no event source
CREATE TABLE IF NOT EXISTS service_status (
  job text PRIMARY KEY,
  last_run timestamptz,
  last_ok timestamptz,
  last_error text,
  last_tx text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  locked_by text,
  locked_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, run_at);

CREATE TABLE IF NOT EXISTS job_schedule (
  name text PRIMARY KEY,
  every_ms integer NOT NULL,
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
