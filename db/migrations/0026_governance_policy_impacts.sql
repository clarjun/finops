-- What fixing each policy would be worth.
--
-- The run already stored the score and the per-domain breakdown, but nothing
-- per policy, and critically nothing about the DENOMINATOR each policy looked
-- at. Only the violations were kept.
--
-- That made the one question a reader actually has unanswerable. "14 findings"
-- is a 70% failure rate if the policy examined 20 things and a rounding error
-- if it examined 3,000 — the score treats those completely differently, and
-- both render identically. Without `checked` nobody can tell which they have,
-- so there is no way to say what to fix first.
--
-- Stored on the run rather than recomputed on read because `checked` exists
-- only while the policy is executing; by the time anyone opens the page the
-- population it examined is gone.
--
-- Shape (array):
--   [{ policyKey, domain, severity, checked, violating, failRate, potentialGain }]
ALTER TABLE governance_runs
  ADD COLUMN IF NOT EXISTS policy_impacts jsonb;

COMMENT ON COLUMN governance_runs.policy_impacts IS
  'Per-policy score impact for this run: what each policy examined, how much of it failed, and the points the overall score would recover if it were brought to zero violations.';
