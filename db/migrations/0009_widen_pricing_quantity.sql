-- Migration: remove the precision ceiling on pricing_quantity
--
-- NUMERIC(24,8) allows 16 digits left of the decimal point. That is ample for
-- money and for most usage metrics, but GCP billing export reports storage in
-- byte-seconds: a few terabytes held for a month is on the order of 1e19, which
-- overflows the column and fails the whole ingestion batch with
-- "numeric field overflow".
--
-- Usage quantity has no natural bound — providers invent units freely (byte-
-- seconds, request-hours, GiB-months) — so constraining its precision buys
-- nothing and costs a class of ingestion failure. Unconstrained NUMERIC in
-- Postgres stores arbitrary precision at the same variable-length cost.
--
-- Money columns keep their precision: NUMERIC(20,10) tops out near 10 billion
-- currency units per line item, and a bound there is a useful sanity check.

BEGIN;

ALTER TABLE cost_facts ALTER COLUMN pricing_quantity TYPE NUMERIC;

COMMENT ON COLUMN cost_facts.pricing_quantity IS
  'Usage amount in pricing_unit. Unconstrained precision: provider units range from bytes to byte-seconds.';

COMMIT;
