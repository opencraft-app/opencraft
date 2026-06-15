ALTER TABLE subscriptions
    DROP INDEX idx_subscriptions_last_refreshed_at,
    DROP COLUMN last_refreshed_at;
