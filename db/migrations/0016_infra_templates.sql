-- Migration: reusable blueprints
--
-- After a deployment succeeds, its architecture is worth keeping as a starting
-- point for the next one. A blueprint is stored as a PLAN rather than a new
-- entity, because that is exactly what it is: a compiled topology plus the
-- answers that produced it. Instantiating one clones the plan and lets the new
-- answers differ.
--
-- Modelling it separately would mean two shapes that must stay in step — a
-- template format and a plan format — and every compiler change would have to be
-- applied twice.
--
-- is_template is a flag rather than a status value because a template has no
-- lifecycle: it is not draft, compiling or deploying, it simply exists to be
-- copied. Overloading `status` would make "which plans can I run" ambiguous.

BEGIN;

ALTER TABLE infra_plans ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE infra_plans ADD COLUMN IF NOT EXISTS template_description TEXT;
-- The deployment that proved this blueprint works. Provenance, same principle
-- as a standard step: a blueprint nobody ever deployed is a proposal, not a
-- pattern, and the two must be distinguishable.
ALTER TABLE infra_plans ADD COLUMN IF NOT EXISTS template_source_run_id BIGINT;
ALTER TABLE infra_plans ADD COLUMN IF NOT EXISTS template_use_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_infra_plans_templates
  ON infra_plans (organization_id, is_template)
  WHERE is_template = true;

COMMENT ON COLUMN infra_plans.is_template IS
  'A saved blueprint: a compiled topology kept to seed future deployments. Templates are cloned, never run directly.';

COMMIT;
