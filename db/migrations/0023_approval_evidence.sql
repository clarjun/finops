-- Put the evidence on the approval.
--
-- The gate already existed and was well built: stages isolate the risky step,
-- propose/approve/execute are different permissions, decisions are audited, and
-- `terraform show -json` was already parsed into a per-resource change list.
--
-- None of it reached the approver. The card showed a sentence — "Creates a
-- database — risk: high" — while the system already knew the plan would set
-- publicly_accessible = true and storage_encrypted = false. An approver who
-- cannot see the facts is not reviewing, and a gate that is always clicked
-- through is worse than no gate: it manufactures a record of oversight that
-- did not happen.
--
-- Two columns, and the difference between them is deliberate.

ALTER TABLE infra_approvals
  -- What Terraform will do, per resource: address, type, and whether it is a
  -- create, update, replace or delete. Attribute VALUES are deliberately NOT
  -- stored here: a plan can contain a generated database password, and while
  -- the parser redacts what Terraform marks sensitive, the safest place for
  -- values it does not mark is nowhere. They are inspected in memory during the
  -- sweep and discarded.
  ADD COLUMN IF NOT EXISTS planned_changes JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The conclusions drawn from those values: "this database will be reachable
  -- from the internet", "this replacement destroys data". Findings are the
  -- durable artefact, because they are what the approver acted on and what an
  -- auditor will ask about later.
  ADD COLUMN IF NOT EXISTS plan_findings JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Answering "which approvals were granted despite a critical finding" should
-- not require scanning every approval ever made. That is the first question
-- asked after an incident.
CREATE INDEX IF NOT EXISTS infra_approvals_findings_idx
  ON infra_approvals USING GIN (plan_findings);
