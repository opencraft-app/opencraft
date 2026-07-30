CREATE TABLE IF NOT EXISTS phone_auth_challenges (
  phone VARCHAR(32) PRIMARY KEY,
  user_id VARCHAR(64) NULL,
  flow VARCHAR(32) NOT NULL,
  code_hash VARCHAR(128) NULL,
  expires_at DATETIME(6) NOT NULL,
  cooldown_until DATETIME(6) NOT NULL,
  remaining_retries INT NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_phone_auth_challenges_user_id (user_id),
  KEY idx_phone_auth_challenges_expires_at (expires_at),
  CONSTRAINT fk_phone_auth_challenge_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
