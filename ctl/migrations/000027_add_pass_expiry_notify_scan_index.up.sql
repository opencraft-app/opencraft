CREATE INDEX `idx_status_expired_id`
    ON `pass` (`status`, `expired_time`, `id`);
