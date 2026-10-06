-- Drop the AI Economics tables.
--
-- The feature and its endpoints are gone, so these tables are unreachable from
-- the application. Left in place they would be read later as "something still
-- uses this", and a schema that describes things nobody writes to is how a
-- codebase stops being trustworthy.
--
-- The FinOps report's AI spend analysis is NOT affected. It classifies spend
-- from cost_facts with isAIService and never touched these tables; the
-- dependency ran one way, from this feature into the report.
--
-- Dropped children-first so the explicit order documents the relationships,
-- with CASCADE as a backstop for any constraint added after these were written.
--
-- On a fresh database, db/baseline.sql still creates these tables and seeds
-- ai_providers, because the baseline represents history up to 0028. This
-- migration then runs and removes them, which is exactly how the baseline is
-- meant to work: it reaches the start of history, and later migrations move
-- forward from there. No baseline regeneration is needed.

DROP TABLE IF EXISTS ai_spend_records CASCADE;
DROP TABLE IF EXISTS ai_usage_records CASCADE;
DROP TABLE IF EXISTS ai_model_pricing CASCADE;
DROP TABLE IF EXISTS ai_models        CASCADE;
DROP TABLE IF EXISTS ai_providers     CASCADE;
DROP TABLE IF EXISTS ai_unit_metrics  CASCADE;
