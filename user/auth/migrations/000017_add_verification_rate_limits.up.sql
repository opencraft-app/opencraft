CREATE TABLE IF NOT EXISTS verification_rate_limits (
  scope VARCHAR(64) NOT NULL,
  subject_hash CHAR(64) NOT NULL,
  window_started_at DATETIME(6) NOT NULL,
  attempts INT NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (scope, subject_hash),
  KEY idx_verification_rate_limits_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE sms_challenges
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 1 AFTER remaining_retries,
  ADD COLUMN reservation_id VARCHAR(64) NULL AFTER generation;

ALTER TABLE phone_auth_challenges
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 1 AFTER remaining_retries,
  ADD COLUMN reservation_id VARCHAR(64) NULL AFTER generation;
