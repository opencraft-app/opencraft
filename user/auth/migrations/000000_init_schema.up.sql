CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  invite_required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uniq_users_email (email),
  UNIQUE KEY uniq_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_credentials (
  user_id VARCHAR(64) PRIMARY KEY,
  password_hash VARBINARY(255) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_password_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sms_challenges (
  phone VARCHAR(32) PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  cooldown_until DATETIME(6) NOT NULL,
  remaining_retries INT NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS invites (
  code VARCHAR(64) PRIMARY KEY,
  state VARCHAR(32) NOT NULL,
  message VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  plan_tier VARCHAR(32) NULL,
  plan_confirmed_at DATETIME(6) NULL,
  authenticated_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_auth_sessions_user_id (user_id),
  KEY idx_auth_sessions_expires_at (expires_at),
  CONSTRAINT fk_auth_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id VARCHAR(64) PRIMARY KEY,
  tier VARCHAR(32) NOT NULL,
  confirmed_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT fk_subscription_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS oauth_identities (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  email VARCHAR(255) NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name VARCHAR(255) NULL,
  avatar_url VARCHAR(512) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_oauth_provider_subject (provider, provider_subject),
  KEY idx_oauth_identities_user_id (user_id),
  CONSTRAINT fk_oauth_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
