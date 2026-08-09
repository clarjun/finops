-- Migration: store the run lease as an instant, not a wall-clock time
--
-- infra_runs.lease_expires_at was TIMESTAMP WITHOUT TIME ZONE. A lease is an
-- instant — "no other worker may touch this run until 12:04:31 UTC" — and a
-- timezone-less column cannot represent one unambiguously. Comparing it against
-- now() (which is timestamptz) makes Postgres cast using the session time zone,
-- and this database runs Asia/Calcutta, so the comparison was off by 5.5 hours.
--
-- The consequences are both directions of wrong, and both are bad:
--   * a live lease read as expired  -> two workers plan and apply the same
--     stage of the same deployment concurrently
--   * an expired lease read as live -> a run whose worker died is never picked
--     up again and stalls forever
--
-- Caught by an integration test that held a lease explicitly. The first version
-- of that test raced three concurrent advance() calls instead, which passed
-- while the bug was present because each call finished in milliseconds.
--
-- Existing values were written as local wall-clock times, so they are
-- interpreted in the current session zone when converting. Leases are
-- short-lived (five minutes) and any value present during this migration is
-- already stale, so the conversion is safe regardless.

BEGIN;

ALTER TABLE infra_runs
  ALTER COLUMN lease_expires_at TYPE TIMESTAMPTZ
  USING lease_expires_at AT TIME ZONE current_setting('TimeZone');

COMMENT ON COLUMN infra_runs.lease_expires_at IS
  'Instant after which another worker may take this run over. timestamptz: a lease is a point in time, not a wall-clock reading.';

-- Releasing a stale lease is the sweep's hot path.
CREATE INDEX IF NOT EXISTS idx_infra_runs_lease
  ON infra_runs (lease_expires_at)
  WHERE lease_owner IS NOT NULL;

COMMIT;
