-- Migration: measured savings
--
-- When an optimization action succeeded, the executor wrote
--   action_feedback.actual_savings = action.estimated_savings
-- and marked performance_impact 'none'. Nothing was measured. The "actual"
-- column was the estimate copied across, so every savings report the product
-- produced was a restatement of its own guess, and the variance column that
-- was supposed to detect bad estimates was structurally always zero.
--
-- This table records a real before/after comparison against ingested cost data.
--
-- The measurement is a difference-in-differences: the target series is compared
-- against a control (the rest of that sub-account's spend) over the same period,
-- so an unrelated org-wide change in spend is not misread as savings. Without
-- the control, shutting down an instance during a month when the company
-- doubled its traffic looks like the optimization failed.
--
-- Granularity is deliberately recorded per row. cost_facts currently carries no
-- resource_id — the connectors group by service and region — so measurement
-- happens at provider + sub-account + service. That is coarser than the change
-- being measured, and other activity in the same service will contaminate it.
-- Rather than hide that, every measurement stores its granularity, a confidence
-- level and a note explaining what could not be isolated. A number labelled
-- low-confidence is useful; a number that pretends to a precision it does not
-- have is not.

BEGIN;

CREATE TABLE IF NOT EXISTS savings_measurements (
  id                          BIGSERIAL PRIMARY KEY,
  organization_id             INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id                   INTEGER      NOT NULL,

  -- What is being measured, at the finest granularity the fact store supports.
  provider                    VARCHAR(20)  NOT NULL,
  sub_account_id              VARCHAR(255),
  service_name                VARCHAR(255),
  region_id                   VARCHAR(100),
  resource_id                 VARCHAR(500),
  granularity                 VARCHAR(20)  NOT NULL DEFAULT 'service', -- resource | service | account

  -- Before
  baseline_start              DATE,
  baseline_end                DATE,
  baseline_days               INTEGER,
  baseline_daily_cost         NUMERIC(20, 10),
  control_baseline_daily_cost NUMERIC(20, 10),

  -- After
  measure_after               TIMESTAMP    NOT NULL,
  measurement_start           DATE,
  measurement_end             DATE,
  measurement_days            INTEGER,
  observed_daily_cost         NUMERIC(20, 10),
  control_observed_daily_cost NUMERIC(20, 10),

  -- Result
  expected_daily_cost         NUMERIC(20, 10),   -- counterfactual: baseline adjusted by the control's drift
  realized_daily_savings      NUMERIC(20, 10),
  realized_monthly_savings    NUMERIC(20, 10),
  estimated_monthly_savings   NUMERIC(20, 10),
  variance_percent            NUMERIC(10, 2),    -- realized vs estimated

  confidence                  VARCHAR(20),       -- high | medium | low
  status                      VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | measured | inconclusive | failed
  notes                       TEXT,

  created_at                  TIMESTAMP    NOT NULL DEFAULT NOW(),
  measured_at                 TIMESTAMP
);

-- One measurement per action.
CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_measurements_action
  ON savings_measurements (organization_id, action_id);

-- The scheduler's query: everything due to be measured.
CREATE INDEX IF NOT EXISTS idx_savings_measurements_due
  ON savings_measurements (status, measure_after)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_savings_measurements_org
  ON savings_measurements (organization_id, status);

COMMENT ON COLUMN savings_measurements.expected_daily_cost IS
  'Counterfactual: what the target would have cost had it changed at the same rate as the control series.';
COMMENT ON COLUMN savings_measurements.confidence IS
  'high = isolated at resource level; medium = service level with a stable control; low = coarse, contaminated, or short window.';

COMMIT;
