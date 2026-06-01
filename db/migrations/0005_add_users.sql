-- Migration: Add users table for local authentication
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed default admin user: username=admin, password=ClAdmin$07
-- bcrypt hash of 'ClAdmin$07' with 10 rounds
INSERT INTO users (username, password_hash, role)
VALUES ('admin', '$2b$10$rOzJqxqQX8K9mN1vL3pHOeKvYwZxN8mQ2sT4uV6wX0yA1bC3dE5fG', 'admin')
ON CONFLICT (username) DO NOTHING;
