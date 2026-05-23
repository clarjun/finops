-- Migration: Add report_cache table for persisting FinOps report data
-- Enables fast retrieval from DB when cache is cold, with async background refresh

CREATE TABLE IF NOT EXISTS report_cache (
  id SERIAL PRIMARY KEY,
  cache_key VARCHAR(500) NOT NULL UNIQUE,
  provider VARCHAR(20) NOT NULL,
  start_date VARCHAR(20) NOT NULL,
  end_date VARCHAR(20) NOT NULL,
  report_data JSONB NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_cache_key ON report_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_report_cache_provider ON report_cache(provider);
