-- Liquidator (todo 17): its own run and attempt log. The batch and liquidation EVENT tables belong to the indexer (0001).
CREATE TABLE IF NOT EXISTS liquidation_runs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  batch_id numeric(78,0),
  gear text NOT NULL,
  vault_ids numeric(78,0)[] NOT NULL DEFAULT '{}',
  phase text NOT NULL CHECK (phase IN ('verified','simulated','sealed','executed','executed_by_other','voided','abandoned')),
  seal_tx text,
  execute_tx text,
  bonus_usdg numeric(78,0),
  bad_debt_usdg numeric(78,0),
  covered_usdg numeric(78,0),
  error text
);
CREATE INDEX IF NOT EXISTS liquidation_runs_ts_idx ON liquidation_runs (ts);
CREATE INDEX IF NOT EXISTS liquidation_runs_batch_idx ON liquidation_runs (batch_id);

CREATE TABLE IF NOT EXISTS liquidation_attempts (
  ts timestamptz NOT NULL DEFAULT now(),
  vault_id numeric(78,0) NOT NULL,
  gear text,
  verdict text NOT NULL,
  ratio_bps numeric(78,0),
  required_bps numeric(78,0),
  reason text
);
CREATE INDEX IF NOT EXISTS liquidation_attempts_ts_idx ON liquidation_attempts (ts);
CREATE INDEX IF NOT EXISTS liquidation_attempts_vault_idx ON liquidation_attempts (vault_id, ts);
