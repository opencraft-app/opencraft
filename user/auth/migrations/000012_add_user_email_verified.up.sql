ALTER TABLE users
  ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE AFTER email;

UPDATE users u
INNER JOIN password_credentials pc ON pc.user_id = u.id
SET u.email_verified = TRUE
WHERE u.email IS NOT NULL AND u.email <> '';

CREATE TABLE IF NOT EXISTS email_bind_tokens (
  user_id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  cooldown_until DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uniq_email_bind_token_hash (token_hash),
  KEY idx_email_bind_tokens_email (email),
  CONSTRAINT fk_email_bind_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
