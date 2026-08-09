-- Migration: remove the second cascade path into infra_events
--
-- 0014 dropped infra_events' foreign key to organizations, but the delete still
-- failed. There was a second route: infra_events.run_id cascades from
-- infra_runs, and infra_runs cascades from organizations. Deleting a tenant
-- therefore still reached the append-only table, one hop further along.
--
-- The rule, stated once and now applied exhaustively: an append-only table must
-- not be the target of ANY cascading delete, direct or transitive. Removing one
-- edge of a cascade graph is not the same as removing the path.
--
-- run_id becomes a plain reference. Events are keyed to a run for reading and
-- replay; they do not need referential integrity to it, and they must outlive it
-- for the same reason they outlive the tenant.

BEGIN;

ALTER TABLE infra_events DROP CONSTRAINT IF EXISTS infra_events_run_id_fkey;

COMMENT ON COLUMN infra_events.run_id IS
  'Run this event belongs to. Intentionally not a foreign key: an append-only table cannot be the target of a cascading delete, and deployment history outlives the run it describes.';

COMMIT;
