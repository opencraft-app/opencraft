CREATE TABLE IF NOT EXISTS developer_route_registrations (
  uin VARCHAR(32) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  delivery_mode VARCHAR(32) NOT NULL,
  source_ip VARCHAR(64) NOT NULL,
  port INT NOT NULL,
  tunnel_host VARCHAR(255) NOT NULL DEFAULT '',
  tunnel_token_hash VARCHAR(64) NOT NULL DEFAULT '',
  renewed_at DATETIME(6) NOT NULL,
  ttl_seconds INT NOT NULL,
  disabled_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_developer_route_registrations_updated_at (updated_at),
  KEY idx_developer_route_registrations_disabled_at (disabled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
