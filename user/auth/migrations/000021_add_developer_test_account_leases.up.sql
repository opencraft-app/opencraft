CREATE TABLE IF NOT EXISTS developer_test_account_leases (
  user_id VARCHAR(64) PRIMARY KEY,
  lease_owner VARCHAR(255) NULL,
  target_ip VARCHAR(64) NULL,
  lease_until DATETIME(6) NULL,
  lease_version BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_developer_test_account_leases_available (lease_until, updated_at),
  KEY idx_developer_test_account_leases_owner (lease_owner, lease_until),
  UNIQUE KEY uq_developer_test_account_leases_owner (lease_owner),
  CONSTRAINT fk_developer_test_account_leases_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
