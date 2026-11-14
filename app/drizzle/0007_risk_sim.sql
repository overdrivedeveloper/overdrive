-- Risk simulator (todo 18). Numbered 0007 (the todo said 0005, taken by parallel lanes). The simulator reads the indexer schema read-only
-- and writes only these three tables plus its own service_status heartbeat. Amounts are plain USD numerics (not raw USDG).
CREATE TABLE IF NOT EXISTS risk_runs (
  run_date date PRIMARY KEY,                         -- one set of rows per UTC date: a rerun replaces them
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('ok','stale_inputs','failed')),
  gate text NOT NULL CHECK (gate IN ('pass','fail','unknown')),
  worst_loss_usd numeric NOT NULL DEFAULT 0,
  worst_scenario text NOT NULL DEFAULT '',
  offending_scenario text,
  equity_usd numeric NOT NULL DEFAULT 0,
  max_loss_bps integer NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  plan jsonb,                                        -- the cap plan that would pass (null when inputs were stale)
  report_path text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS risk_scenario_results (
  run_date date NOT NULL REFERENCES risk_runs (run_date) ON DELETE CASCADE,
  scenario text NOT NULL,
  status text NOT NULL,                              -- ok | data_missing
  worst_loss_usd numeric NOT NULL DEFAULT 0,
  worst_case text NOT NULL DEFAULT '',
  contract_budget_usd numeric,
  flags text[] NOT NULL DEFAULT '{}',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_date, scenario)
);

CREATE TABLE IF NOT EXISTS risk_caps (
  run_date date NOT NULL REFERENCES risk_runs (run_date) ON DELETE CASCADE,
  gear text NOT NULL,                                -- 'TSLA:2'
  grp text NOT NULL,
  cap_usd numeric NOT NULL,
  spec_max_usd numeric NOT NULL,
  factor numeric NOT NULL,
  spread_bps integer NOT NULL,
  PRIMARY KEY (run_date, gear)
);
CREATE INDEX IF NOT EXISTS risk_caps_date_idx ON risk_caps (run_date DESC);
