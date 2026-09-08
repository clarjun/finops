-- Migration: audit logs survive tenant deletion
--
-- 0006 gave audit_logs.organization_id an ON DELETE CASCADE foreign key while
-- also making the table append-only via trigger. Those two rules contradict
-- each other: deleting an organization cascades a DELETE into audit_logs, the
-- trigger rejects it, and the whole transaction aborts. The practical effect is
-- that no organization could ever be deleted once it had a single audit row.
--
-- The fix is not to weaken the trigger. Retaining the audit trail of a tenant
-- after offboarding is the behaviour a compliance review expects — "we deleted
-- the customer and their entire activity history with them" is the wrong
-- answer. So organization_id becomes a plain historical reference with no
-- foreign key, and audit rows outlive the organization they describe.
--
-- Tenant offboarding therefore needs to be an explicit operation that removes
-- tenant data and leaves the audit trail behind. There is no such endpoint yet;
-- deleting an org is a deliberate database action until one exists.

BEGIN;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_organization_id_fkey;

COMMENT ON COLUMN audit_logs.organization_id IS
  'Organization this event belongs to. Intentionally not a foreign key: audit history is retained after a tenant is deleted.';

COMMIT;
