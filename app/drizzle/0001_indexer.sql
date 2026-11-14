-- Indexer tables. Every event table has block, tx_hash, log_index with a unique (tx_hash, log_index) and an index on block
-- (rollback deletes rows above the common ancestor).
CREATE TABLE IF NOT EXISTS trades (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  gear text NOT NULL, account text NOT NULL, recipient text, side text NOT NULL CHECK (side IN ('buy','sell')),
  tokens numeric(78,0) NOT NULL, usdg numeric(78,0) NOT NULL, value_per_token numeric(78,0), spread_bps integer, session text,
  via text NOT NULL CHECK (via IN ('hook','minter','queue')),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS trades_block_idx ON trades (block);
CREATE INDEX IF NOT EXISTS trades_gear_ts_idx ON trades (gear, ts DESC);
CREATE INDEX IF NOT EXISTS trades_account_idx ON trades (account);

CREATE TABLE IF NOT EXISTS transfers (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  token text NOT NULL, from_addr text NOT NULL, to_addr text NOT NULL, amount numeric(78,0) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_block_idx ON transfers (block);
CREATE INDEX IF NOT EXISTS transfers_token_idx ON transfers (token, ts DESC);

CREATE TABLE IF NOT EXISTS balances (
  token text NOT NULL, account text NOT NULL, balance numeric(78,0) NOT NULL,
  PRIMARY KEY (token, account)
);

CREATE TABLE IF NOT EXISTS prices (
  underlying text NOT NULL, ts timestamptz NOT NULL, block bigint, price_wad numeric(78,0) NOT NULL,
  session text, fresh boolean NOT NULL DEFAULT true, source text, multiplier_wad numeric(78,0),
  PRIMARY KEY (underlying, ts)
);
CREATE INDEX IF NOT EXISTS prices_underlying_ts_idx ON prices (underlying, ts DESC);
CREATE INDEX IF NOT EXISTS prices_block_idx ON prices (block);

CREATE TABLE IF NOT EXISTS vol_posts (
  gear_or_underlying text NOT NULL, ts timestamptz NOT NULL, block bigint NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
  sigma_bps numeric(78,0) NOT NULL, valid_until timestamptz, signer text,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS vol_posts_block_idx ON vol_posts (block);
CREATE INDEX IF NOT EXISTS vol_posts_key_ts_idx ON vol_posts (gear_or_underlying, ts DESC);

CREATE TABLE IF NOT EXISTS queued_sells (
  ticket numeric(78,0) PRIMARY KEY, gear text NOT NULL, account text NOT NULL, tokens numeric(78,0) NOT NULL,
  min_proceeds numeric(78,0) NOT NULL, queued_block bigint NOT NULL, queued_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open','filled','cancelled')), filled_block bigint
);
CREATE INDEX IF NOT EXISTS queued_sells_status_idx ON queued_sells (status, gear);
CREATE INDEX IF NOT EXISTS queued_sells_block_idx ON queued_sells (queued_block);

CREATE TABLE IF NOT EXISTS liquidation_batches (
  batch_id numeric(78,0) PRIMARY KEY, gear text NOT NULL, sealed_value_wad numeric(78,0), sealed_at timestamptz,
  vault_ids numeric(78,0)[] NOT NULL DEFAULT '{}', status text NOT NULL CHECK (status IN ('sealed','executed','voided','expired')),
  sealed_block bigint, closed_block bigint, void_reason text
);
CREATE INDEX IF NOT EXISTS liquidation_batches_block_idx ON liquidation_batches (sealed_block);

CREATE TABLE IF NOT EXISTS liquidations (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  batch_id numeric(78,0), vault_id numeric(78,0) NOT NULL, debt_tokens numeric(78,0) NOT NULL,
  collateral_seized numeric(78,0) NOT NULL, bonus_usdg numeric(78,0), bad_debt_usdg numeric(78,0),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS liquidations_block_idx ON liquidations (block);
CREATE INDEX IF NOT EXISTS liquidations_vault_idx ON liquidations (vault_id);

CREATE TABLE IF NOT EXISTS pause_log (
  ts timestamptz NOT NULL, block bigint NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global','gear','underlying')), ref text, action text NOT NULL CHECK (action IN ('pause','unpause')),
  actor text, reason text,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS pause_log_block_idx ON pause_log (block);
CREATE INDEX IF NOT EXISTS pause_log_ts_idx ON pause_log (ts DESC);

CREATE TABLE IF NOT EXISTS stock_events (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  token text NOT NULL, kind text NOT NULL CHECK (kind IN ('ui_multiplier','oracle_paused','oracle_unpaused')),
  old_wad numeric(78,0), new_wad numeric(78,0), effective_at timestamptz,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS stock_events_block_idx ON stock_events (block);
CREATE INDEX IF NOT EXISTS stock_events_token_idx ON stock_events (token, ts DESC);

CREATE TABLE IF NOT EXISTS exit_reserve_log (
  ts timestamptz NOT NULL, block bigint NOT NULL, tx_hash text NOT NULL DEFAULT '', log_index integer NOT NULL DEFAULT -1,
  balance numeric(78,0) NOT NULL, "floor" numeric(78,0) NOT NULL, ring_fenced boolean NOT NULL DEFAULT true,
  PRIMARY KEY (ts, block, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS exit_reserve_log_block_idx ON exit_reserve_log (block);

CREATE TABLE IF NOT EXISTS stake_events (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  kind text NOT NULL, account text, amount numeric(78,0), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS stake_events_block_idx ON stake_events (block);

CREATE TABLE IF NOT EXISTS agent_policies (
  owner text NOT NULL, agent text NOT NULL, budget_usdg numeric(78,0), expires_at timestamptz, revoked boolean NOT NULL DEFAULT false,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb, updated_block bigint NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
  PRIMARY KEY (owner, agent)
);
CREATE INDEX IF NOT EXISTS agent_policies_block_idx ON agent_policies (updated_block);

CREATE TABLE IF NOT EXISTS agent_trades (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  owner text, agent text, gear text, side text, tokens numeric(78,0), usdg numeric(78,0),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS agent_trades_block_idx ON agent_trades (block);

CREATE TABLE IF NOT EXISTS admin_events (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  source text NOT NULL, kind text NOT NULL, op_id text, target text, eta timestamptz, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS admin_events_block_idx ON admin_events (block);
CREATE INDEX IF NOT EXISTS admin_events_op_idx ON admin_events (op_id);

CREATE TABLE IF NOT EXISTS indexer_skipped_events (
  block bigint NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL, address text, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS indexer_skipped_events_block_idx ON indexer_skipped_events (block);

CREATE TABLE IF NOT EXISTS cursors (
  name text PRIMARY KEY, block bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS block_hashes (
  block bigint PRIMARY KEY, hash text NOT NULL, parent_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS reorg_log (
  id bigserial PRIMARY KEY, detected_at timestamptz NOT NULL DEFAULT now(), ancestor bigint NOT NULL, depth bigint NOT NULL,
  rows_removed integer NOT NULL DEFAULT 0
);

-- Replayable state changes of entities that handlers update in place (gears, vaults, queued sells, batches, agent policies).
-- Rollback deletes events above the common ancestor and rebuilds the touched entities by replaying what remains.
CREATE TABLE IF NOT EXISTS entity_events (
  tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  scope text NOT NULL, ref text NOT NULL, kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tx_hash, log_index, scope, ref)
);
CREATE INDEX IF NOT EXISTS entity_events_block_idx ON entity_events (block);
CREATE INDEX IF NOT EXISTS entity_events_entity_idx ON entity_events (scope, ref, block, log_index);
