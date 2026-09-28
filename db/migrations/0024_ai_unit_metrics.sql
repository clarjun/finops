-- Business denominators for AI unit economics.
--
-- "We spent $18,700 on AI last month" is a number. "$0.37 per active user" is a
-- decision — it can be compared to revenue per user, tracked as the product
-- scales, and argued about in a pricing meeting. The FinOps Foundation's 2026
-- report names unit economics as the capability that most separates mature
-- practices from early ones, and only 43% of organisations do it at all.
--
-- The denominator cannot be derived from cloud billing: only the customer knows
-- how many active users, transactions or documents processed a period had. So
-- they tell us, per period, and we do the division.
--
-- One row per (organization, metric, period). Per period rather than a single
-- current value because the whole point is the trend: a cost per user that is
-- falling as usage grows is the signal a team is looking for, and a single
-- mutable number destroys the history that shows it.

CREATE TABLE IF NOT EXISTS ai_unit_metrics (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER      NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,

  -- What is being counted, in the customer's own words: "Monthly active users",
  -- "Documents processed", "Support tickets deflected".
  name            VARCHAR(120) NOT NULL,
  -- Singular noun for display: "user", "document". Lets the UI render
  -- "$0.37 per user" rather than "$0.37 per Monthly active users".
  unit_label      VARCHAR(60)  NOT NULL DEFAULT 'unit',

  -- First day of the month this value describes. Stored as a date, not a
  -- timestamp: a business metric belongs to a period, not an instant, and a
  -- timestamp invites timezone bugs at month boundaries.
  period_start    DATE         NOT NULL,

  -- NUMERIC, not INTEGER. Some denominators are genuinely fractional — average
  -- concurrent sessions, thousands of requests — and rounding them silently
  -- would skew every derived figure.
  value           NUMERIC(20,4) NOT NULL,

  notes           TEXT,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One value per metric per period. Re-submitting a month corrects it rather
-- than adding a second, contradictory figure.
CREATE UNIQUE INDEX IF NOT EXISTS ai_unit_metrics_org_name_period_idx
  ON ai_unit_metrics (organization_id, name, period_start);

-- The read path: "the value for this metric covering this window".
CREATE INDEX IF NOT EXISTS ai_unit_metrics_org_period_idx
  ON ai_unit_metrics (organization_id, period_start DESC);

-- A zero or negative denominator produces a division by zero or a negative
-- cost per unit, and both would be rendered to a user as though they meant
-- something.
ALTER TABLE ai_unit_metrics DROP CONSTRAINT IF EXISTS ai_unit_metrics_value_positive;
ALTER TABLE ai_unit_metrics ADD CONSTRAINT ai_unit_metrics_value_positive CHECK (value > 0);
