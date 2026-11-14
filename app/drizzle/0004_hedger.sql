-- Hedger (todo 16). Numbered 0004 so it cannot collide with a parallel 0003 migration. Amounts are raw USDG (6 dp),
-- signed where a direction matters (positive = long). The hedger writes these three tables only.
CREATE TABLE IF NOT EXISTS hedges (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  venue text NOT NULL,
  underlying text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  usd numeric(78,0) NOT NULL,                       -- signed filled notional
  px numeric(78,0) NOT NULL,                        -- WAD USD per unit
  fees_usd numeric(78,0) NOT NULL DEFAULT 0,
  ref text,
  reason text NOT NULL,
  dry boolean NOT NULL,
  client_id text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS hedges_underlying_ts_idx ON hedges (underlying, ts DESC);

CREATE TABLE IF NOT EXISTS hedge_cycles (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL,
  underlying text NOT NULL,
  delta_usd numeric(78,0) NOT NULL,
  gamma_usd numeric(78,0) NOT NULL,
  position_usd numeric(78,0) NOT NULL,
  residual_usd numeric(78,0) NOT NULL,
  band_usd numeric(78,0) NOT NULL,
  action text NOT NULL CHECK (action IN ('traded','would_trade','hold','failed')),
  reason text NOT NULL,
  input_age_s integer
);
CREATE INDEX IF NOT EXISTS hedge_cycles_underlying_ts_idx ON hedge_cycles (underlying, ts DESC);

CREATE TABLE IF NOT EXISTS hedger_signals (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('gamma_over_budget','unhedged','venue_down','proxy_basis','disagree_with_chain','stale_inputs','hedge_post_missed')),
  underlying text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  cleared_at timestamptz
);
-- at most one open signal per kind and name
CREATE UNIQUE INDEX IF NOT EXISTS hedger_signals_open_idx ON hedger_signals (kind, underlying) WHERE cleared_at IS NULL;
