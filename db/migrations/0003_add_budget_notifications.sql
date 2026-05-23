-- Migration: Add notification fields to budgets table
-- This allows budgets to send email and webhook notifications directly
-- without depending on the alert_rules table

-- Add email recipients column (comma-separated emails)
ALTER TABLE budgets 
ADD COLUMN IF NOT EXISTS email_recipients TEXT;

-- Add webhook URL column (for Teams/Slack notifications)
ALTER TABLE budgets 
ADD COLUMN IF NOT EXISTS webhook_url TEXT;

-- Add last alerted timestamp to prevent duplicate alerts
ALTER TABLE budgets 
ADD COLUMN IF NOT EXISTS last_alerted_at TIMESTAMP;

-- Add last alerted threshold to track which threshold was last triggered
ALTER TABLE budgets 
ADD COLUMN IF NOT EXISTS last_alerted_threshold INTEGER;

-- Add comments for documentation
COMMENT ON COLUMN budgets.email_recipients IS 'Comma-separated list of email addresses to notify when thresholds are exceeded';
COMMENT ON COLUMN budgets.webhook_url IS 'Webhook URL for Teams/Slack notifications';
COMMENT ON COLUMN budgets.last_alerted_at IS 'Timestamp of last alert sent to prevent spam';
COMMENT ON COLUMN budgets.last_alerted_threshold IS 'Last threshold percentage that triggered an alert (50, 75, 90, or 100)';
