-- R-MR-1 monthly token refresh — Q3=c1 + Q6 (2026-05-18 user decision):
--   - Add `last_refreshed_at` column to track when each subscription's
--     token_balance was last reset to plan.monthly_tokens.
--   - Anchor existing active subscriptions at `period_start`. The b3 (same-day-
--     of-month) scheduler will then advance the anchor through past months on
--     the first tick after deploy, ending up at the most recent past anchor
--     <= NOW, and overwriting token_balance to plan.monthly_tokens at that
--     point. This intentionally lets legacy users keep their currently-stored
--     balance (potentially 3M for a 3-month plan) until the first refresh,
--     after which they enter the standard monthly cadence (1M/month).
--   - We DO NOT touch token_balance here: the design (.tmp/aigateway-monthly-
--     token-refresh-design.md §6.3 v0.2.3) explicitly chooses zero-backfill
--     to minimise migration risk and DBA coordination burden.

ALTER TABLE subscriptions
    ADD COLUMN last_refreshed_at DATETIME NULL,
    ADD INDEX idx_subscriptions_last_refreshed_at (last_refreshed_at);

UPDATE subscriptions
SET last_refreshed_at = period_start
WHERE status = 'active'
  AND last_refreshed_at IS NULL;
