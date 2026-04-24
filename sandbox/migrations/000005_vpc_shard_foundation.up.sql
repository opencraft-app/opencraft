CREATE TABLE IF NOT EXISTS vpc_shards (
  id VARCHAR(64) PRIMARY KEY,
  blueprint_snapshot_id VARCHAR(64) NOT NULL DEFAULT '',
  blueprint_fingerprint VARCHAR(128) NOT NULL,
  template_class_id VARCHAR(64) NOT NULL,
  sku_id VARCHAR(64) NOT NULL,
  network_template_id VARCHAR(64) NOT NULL,
  region VARCHAR(64) NOT NULL,
  vpc_id VARCHAR(128) NOT NULL DEFAULT '',
  state VARCHAR(32) NOT NULL,
  active_subnet_member_id VARCHAR(64) NOT NULL DEFAULT '',
  last_switch_at DATETIME(6) NULL,
  last_waterline_reason TEXT,
  cleanup_state VARCHAR(32) NOT NULL DEFAULT '',
  cleanup_started_at DATETIME(6) NULL,
  cleanup_last_error TEXT,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_vpc_shards_blueprint_region (blueprint_fingerprint, region),
  KEY idx_vpc_shards_blueprint_snapshot (blueprint_snapshot_id),
  KEY idx_vpc_shards_template_class (template_class_id),
  KEY idx_vpc_shards_sku (sku_id),
  KEY idx_vpc_shards_cleanup_state (cleanup_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS vpc_shard_blueprint_snapshots (
  id VARCHAR(64) PRIMARY KEY,
  schema_version VARCHAR(32) NOT NULL,
  source_region VARCHAR(64) NOT NULL,
  network_template_id VARCHAR(64) NOT NULL DEFAULT '',
  blueprint_fingerprint VARCHAR(128) NOT NULL,
  topology_json LONGTEXT NOT NULL,
  validation_state VARCHAR(32) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL,
  KEY idx_vpc_shard_blueprint_snapshots_fp (blueprint_fingerprint),
  KEY idx_vpc_shard_blueprint_snapshots_network_template (network_template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS vpc_shard_provision_progress (
  id VARCHAR(64) PRIMARY KEY,
  vpc_shard_id VARCHAR(64) NOT NULL,
  blueprint_snapshot_id VARCHAR(64) NOT NULL,
  blueprint_fingerprint VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  last_step VARCHAR(128) NOT NULL DEFAULT '',
  last_error TEXT,
  started_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  UNIQUE KEY uniq_vpc_shard_provision_progress_shard (vpc_shard_id),
  KEY idx_vpc_shard_provision_progress_snapshot (blueprint_snapshot_id),
  KEY idx_vpc_shard_provision_progress_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS vpc_shard_create_locks (
  id VARCHAR(192) PRIMARY KEY,
  blueprint_fingerprint VARCHAR(128) NOT NULL,
  region VARCHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_vpc_shard_create_locks_fp_region (blueprint_fingerprint, region)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS vpc_shard_subnets (
  id VARCHAR(64) PRIMARY KEY,
  vpc_shard_id VARCHAR(64) NOT NULL,
  subnet_id VARCHAR(128) NOT NULL,
  zone VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  ordinal INT NOT NULL DEFAULT 0,
  reservation_state VARCHAR(32) NOT NULL,
  near_waterline BOOL NOT NULL DEFAULT FALSE,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_vpc_shard_subnets_shard (vpc_shard_id),
  KEY idx_vpc_shard_subnets_selectable (vpc_shard_id, role, reservation_state, near_waterline, ordinal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS vpc_shard_cleanup_resources (
  id VARCHAR(64) PRIMARY KEY,
  vpc_shard_id VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id VARCHAR(128) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_vpc_shard_cleanup_resources_shard (vpc_shard_id),
  KEY idx_vpc_shard_cleanup_resources_type (resource_type, resource_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
