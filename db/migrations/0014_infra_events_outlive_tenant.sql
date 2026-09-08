-- Migration: deployment events survive tenant deletion
--
-- infra_events was given ON DELETE CASCADE to organizations while also being
-- append-only by trigger. Those contradict: deleting an organization cascades a
-- DELETE into infra_events, the trigger rejects it, and the whole transaction
-- aborts. An organization with a single deployment event could never be removed.
--
-- This is the same defect migration 0007 fixed for audit_logs, reintroduced in
-- 0012 by copying that table's shape without carrying over its correction. The
-- rule is general and worth stating plainly: an append-only table must not be
-- the target of a cascading delete.
--
-- The resolution matches 0007's. A deployment's history is exactly what an audit
-- needs after a tenant is offboarded — "we deleted the customer and every record
-- of what we built in their account" is the wrong answer — so organization_id
-- becomes a plain historical reference with no foreign key.
--
-- Found by an integration test whose cleanup deleted its own test organization.

BEGIN;

ALTER TABLE infra_events DROP CONSTRAINT IF EXISTS infra_events_organization_id_fkey;

COMMENT ON COLUMN infra_events.organization_id IS
  'Organization this event belongs to. Intentionally not a foreign key: deployment history is retained after a tenant is deleted, and an append-only table cannot be the target of a cascading delete.';

COMMIT;
