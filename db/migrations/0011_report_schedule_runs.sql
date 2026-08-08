-- Migration: record report schedule execution
--
-- report_schedules has had next_run_at since it was created and storage.ts has
-- had getDueReportSchedules(), but nothing ever called it. Scheduled reports
-- have never been sent: a customer could configure a weekly cost report, see it
-- listed in the UI, and simply never receive anything, with no error anywhere.
--
-- Wiring the scheduler without recording outcomes would replace silence with a
-- different silence — a delivery that fails at the SMTP layer would look
-- identical to one that succeeded. These columns make the last attempt visible.

BEGIN;

ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS last_run_at     TIMESTAMP;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS last_run_status VARCHAR(20);   -- success | failed | skipped
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS last_run_error  TEXT;

CREATE INDEX IF NOT EXISTS idx_report_schedules_due
  ON report_schedules (is_enabled, next_run_at);

COMMENT ON COLUMN report_schedules.last_run_status IS
  'Outcome of the most recent delivery attempt. skipped means there was no cost data to report.';

COMMIT;
