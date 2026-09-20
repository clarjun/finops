-- Make resource_inventory upsertable.
--
-- The table has existed since the first schema and has never had a row written
-- to it: storage.createResourceInventory() had no callers. That was invisible
-- until governance arrived, because three of its policies — idle waste,
-- public exposure and encryption at rest — read the inventory and had nothing
-- to read. They report "not assessed" rather than "compliant", so the gap is
-- honest, but it is still a gap.
--
-- A resource sync has to be idempotent: it runs every few hours and must update
-- what it already recorded rather than append a new row per sweep. That needs a
-- uniqueness constraint to conflict on, which the table never had.

-- Deduplicate anything that predates the constraint. Keeps the most recently
-- seen row per resource, which is the one the sync would have written anyway.
DELETE FROM resource_inventory a
 USING resource_inventory b
 WHERE a.organization_id = b.organization_id
   AND a.provider        = b.provider
   AND a.resource_id     = b.resource_id
   AND (a.last_seen_at, a.id) < (b.last_seen_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS resource_inventory_org_provider_resource_idx
  ON resource_inventory (organization_id, provider, resource_id);

-- The sweep's own query: "what is in this tenant's estate that we saw recently".
CREATE INDEX IF NOT EXISTS resource_inventory_org_last_seen_idx
  ON resource_inventory (organization_id, last_seen_at DESC);
