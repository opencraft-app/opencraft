CREATE TABLE IF NOT EXISTS template_classes (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  workload_type VARCHAR(64) NOT NULL DEFAULT '',
  region VARCHAR(32) NOT NULL DEFAULT '',
  default_pool_selection_policy VARCHAR(32) NOT NULL DEFAULT 'priority',
  resolution_mode VARCHAR(32) NOT NULL DEFAULT 'legacy',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  import_generation BIGINT NOT NULL DEFAULT 0,
  divergence_message TEXT,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS template_pool_bindings (
  template_class_id VARCHAR(64) NOT NULL,
  pool_id VARCHAR(64) NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  weight INT NOT NULL DEFAULT 1,
  role VARCHAR(16) NOT NULL DEFAULT 'primary',
  admission_state VARCHAR(16) NOT NULL DEFAULT 'active',
  reason TEXT,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (template_class_id, pool_id),
  KEY idx_template_binding_admission (template_class_id, admission_state, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS pool_autoscale_policies (
  template_class_id VARCHAR(64) PRIMARY KEY,
  min_pool_count INT NOT NULL DEFAULT 0,
  max_pool_count INT NOT NULL DEFAULT 0,
  min_clean_per_pool INT NOT NULL DEFAULT 0,
  target_clean_per_pool INT NOT NULL DEFAULT 0,
  max_clean_per_pool INT NOT NULL DEFAULT 0,
  warm_bundle_target INT NOT NULL DEFAULT 0,
  slow_horizon_target INT NOT NULL DEFAULT 0,
  scale_out_cooldown_seconds INT NOT NULL DEFAULT 0,
  scale_in_cooldown_seconds INT NOT NULL DEFAULT 0,
  refill_failure_threshold INT NOT NULL DEFAULT 0,
  zone_failure_threshold INT NOT NULL DEFAULT 0,
  capacity_pressure_limit_pct INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS capacity_bundles (
  id VARCHAR(64) PRIMARY KEY,
  region VARCHAR(32) NOT NULL,
  zone VARCHAR(32) NOT NULL,
  vpc_id VARCHAR(64) NOT NULL,
  subnet_id VARCHAR(64) NOT NULL,
  security_group_ids TEXT,
  network_template_id VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'provisioning',
  bootstrap_generation INT NOT NULL DEFAULT 0,
  lineage_tags TEXT,
  last_validation_result TEXT,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE pools
  ADD COLUMN template_class_id VARCHAR(64) NOT NULL DEFAULT '' AFTER security_groups,
  ADD COLUMN capacity_state VARCHAR(16) NOT NULL DEFAULT 'active' AFTER template_class_id,
  ADD COLUMN max_capacity INT NOT NULL DEFAULT 0 AFTER capacity_state,
  ADD COLUMN capacity_bundle_id VARCHAR(64) NOT NULL DEFAULT '' AFTER max_capacity,
  ADD COLUMN autoscale_generation BIGINT NOT NULL DEFAULT 0 AFTER capacity_bundle_id,
  ADD COLUMN last_autoscale_action VARCHAR(64) NOT NULL DEFAULT '' AFTER autoscale_generation,
  ADD COLUMN last_health_transition_at DATETIME(6) NULL AFTER last_autoscale_action;

ALTER TABLE pools
  ADD KEY idx_pools_template_class (template_class_id),
  ADD KEY idx_pools_capacity_bundle (capacity_bundle_id);

ALTER TABLE sandboxes
  ADD COLUMN template_class_id VARCHAR(64) NOT NULL DEFAULT '' AFTER pool_id,
  ADD COLUMN resolution_mode VARCHAR(32) NOT NULL DEFAULT '' AFTER template_class_id,
  ADD COLUMN resolution_source VARCHAR(32) NOT NULL DEFAULT '' AFTER resolution_mode,
  ADD COLUMN resolution_divergence TEXT AFTER resolution_source;
