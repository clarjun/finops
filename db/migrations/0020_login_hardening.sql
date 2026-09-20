-- Durable brute-force protection for sign-in.
--
-- The in-process rate limiter in server/middleware/rate-limit.ts bounds attempts
-- per IP, but it has two gaps that matter for credential stuffing:
--
--   1. It is per replica. Behind Azure Container Apps, N replicas means N times
--      the allowance, and the attacker does not have to do anything clever to
--      get it — round-robin load balancing hands it to them.
--   2. It is per IP. Stuffing a leaked credential list comes from thousands of
--      addresses, each making a handful of attempts. Every one stays under an
--      IP-based limit while the account is hammered.
--
-- Counting against the ACCOUNT, in the database, closes both. The two controls
-- are complementary rather than redundant: the limiter stops one host trying
-- many accounts, this stops many hosts trying one account.

ALTER TABLE users
  -- Reset to zero by any successful sign-in.
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  -- NULL means not locked. A timestamp in the past is an expired lock, which
  -- the login path treats as unlocked rather than clearing eagerly — no
  -- background job is needed to unlock anybody.
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  -- Kept for the "unusual sign-in location" conversation a customer will
  -- eventually ask for, and useful on its own when reviewing a compromise.
  ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64);

-- Finding the locked accounts must not scan the table during an incident.
CREATE INDEX IF NOT EXISTS users_locked_until_idx
  ON users (locked_until)
  WHERE locked_until IS NOT NULL;
