CREATE TABLE IF NOT EXISTS pools (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  base_image VARCHAR(128) NOT NULL,
  desired_capacity INT NOT NULL DEFAULT 0,
  instance_type VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  pause_reason TEXT,
  consecutive_refill_failures INT NOT NULL DEFAULT 0,
  last_refill_error_code VARCHAR(128) NOT NULL DEFAULT '',
  last_refill_error TEXT,
  vpc_id VARCHAR(64) NOT NULL,
  subnet_id VARCHAR(64) NOT NULL,
  zone VARCHAR(32) NOT NULL,
  security_groups TEXT,
  created_at DATETIME(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  id VARCHAR(64) PRIMARY KEY,
  pool_id VARCHAR(64) NOT NULL,
  state VARCHAR(20) NOT NULL,
  cloud_id VARCHAR(128),
  address VARCHAR(128),
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_pool_state (pool_id, state),
  CONSTRAINT fk_pool FOREIGN KEY (pool_id) REFERENCES pools(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id VARCHAR(64) PRIMARY KEY,
  instance_id VARCHAR(64) NOT NULL,
  pool_id VARCHAR(64) NOT NULL,
  metadata TEXT,
  env_vars TEXT,
  timeout_seconds INT,
  auto_pause BOOL,
  secure BOOL,
  allow_internet BOOL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_instance (instance_id),
  CONSTRAINT fk_instance FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
);
