CREATE TABLE IF NOT EXISTS shadow_bindings (
  user_id VARCHAR(64) PRIMARY KEY,
  shadow_user_name VARCHAR(128) NOT NULL,
  uin BIGINT NULL,
  owner_uin BIGINT NULL,
  app_id BIGINT NULL,
  status VARCHAR(32) NOT NULL,
  last_error_code VARCHAR(64) NULL,
  last_error_message VARCHAR(512) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_shadow_bindings_status (status),
  KEY idx_shadow_bindings_uin (uin),
  CONSTRAINT fk_shadow_binding_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shadow_auth_codes (
  code VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_shadow_auth_codes_user_id (user_id),
  KEY idx_shadow_auth_codes_expires_at (expires_at),
  CONSTRAINT fk_shadow_auth_code_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
