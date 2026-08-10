-- Every instant the agent records becomes timestamptz.
--
-- Migration 0013 fixed exactly one column, lease_expires_at, because that was
-- the one whose breakage was visible: a lease compared against now() read as
-- expired five and a half hours early, so two workers could drive one
-- deployment. The same fault was left in every other timestamp on these tables.
--
-- It is invisible in a duration, because subtracting two columns with an
-- identical offset gives the right answer — which is why the finished
-- deployments on screen showed plausible times. It is wrong wherever a stored
-- instant is compared against now():
--
--   a resource still being created shows a live elapsed time off by the offset
--   a step's 90-day freshness window starts in the wrong place
--   "this deployment has been running for N hours" is simply wrong
--
-- The app writes JS Date values, which node-postgres serialises with the local
-- offset; a `timestamp without time zone` column then discards that offset and
-- keeps the wall-clock reading. Existing rows are therefore local wall time, and
-- are reinterpreted here using the database's own zone rather than a hardcoded
-- one, so this migration is correct wherever it runs rather than only here.

BEGIN;

ALTER TABLE infra_plans
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN updated_at       TYPE TIMESTAMPTZ USING updated_at       AT TIME ZONE current_setting('TimeZone');

ALTER TABLE infra_plan_nodes
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone');

ALTER TABLE infra_runs
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN updated_at       TYPE TIMESTAMPTZ USING updated_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN started_at       TYPE TIMESTAMPTZ USING started_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN finished_at      TYPE TIMESTAMPTZ USING finished_at      AT TIME ZONE current_setting('TimeZone');

ALTER TABLE infra_run_nodes
  ALTER COLUMN updated_at       TYPE TIMESTAMPTZ USING updated_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN started_at       TYPE TIMESTAMPTZ USING started_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN finished_at      TYPE TIMESTAMPTZ USING finished_at      AT TIME ZONE current_setting('TimeZone');

ALTER TABLE infra_approvals
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN decided_at       TYPE TIMESTAMPTZ USING decided_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN expires_at       TYPE TIMESTAMPTZ USING expires_at       AT TIME ZONE current_setting('TimeZone');

ALTER TABLE infra_deployments
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN updated_at       TYPE TIMESTAMPTZ USING updated_at       AT TIME ZONE current_setting('TimeZone');

ALTER TABLE standard_steps
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN updated_at       TYPE TIMESTAMPTZ USING updated_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN last_validated_at TYPE TIMESTAMPTZ USING last_validated_at AT TIME ZONE current_setting('TimeZone');

ALTER TABLE doc_sources
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone'),
  ALTER COLUMN retrieved_at     TYPE TIMESTAMPTZ USING retrieved_at     AT TIME ZONE current_setting('TimeZone');

-- infra_events.created_at is deliberately last: the table is append-only,
-- enforced by a trigger that rejects UPDATE and DELETE. ALTER TABLE changes the
-- column type rather than the rows, so the trigger does not fire — but it is
-- worth stating that this was checked rather than assumed.
ALTER TABLE infra_events
  ALTER COLUMN created_at       TYPE TIMESTAMPTZ USING created_at       AT TIME ZONE current_setting('TimeZone');

COMMIT;
