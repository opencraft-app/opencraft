CREATE TABLE IF NOT EXISTS skus (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  template_class_id VARCHAR(64) NOT NULL,
  base_image VARCHAR(128) NOT NULL,
  desired_image_id VARCHAR(128) NOT NULL,
  stable_image_id VARCHAR(128) NOT NULL DEFAULT '',
  instance_type VARCHAR(64) NOT NULL,
  network_template_id VARCHAR(64) NOT NULL DEFAULT '',
  security_group_rule_template_id VARCHAR(64) NOT NULL DEFAULT '',
  autoscale_policy_id VARCHAR(64) NOT NULL DEFAULT '',
  default_desired_capacity INT NOT NULL DEFAULT 0,
  rollout_state VARCHAR(32) NOT NULL DEFAULT 'stable',
  rollout_cursor_pool_id VARCHAR(64) NOT NULL DEFAULT '',
  generation BIGINT NOT NULL DEFAULT 0,
  converged_pool_count INT NOT NULL DEFAULT 0,
  total_pool_count INT NOT NULL DEFAULT 0,
  pools_pending_rollout INT NOT NULL DEFAULT 0,
  last_rollout_started_at DATETIME(6) NULL,
  last_rollout_error TEXT,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_skus_template_class (template_class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS template_sku_bindings (
  template_class_id VARCHAR(64) NOT NULL,
  sku_id VARCHAR(64) NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  weight INT NOT NULL DEFAULT 1,
  admission_state VARCHAR(32) NOT NULL DEFAULT 'active',
  region_affinity VARCHAR(64) NOT NULL DEFAULT '',
  rollout_eligibility BOOL NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (template_class_id, sku_id),
  KEY idx_template_sku_binding_admission (template_class_id, admission_state, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE pools
  ADD COLUMN sku_id VARCHAR(64) NOT NULL DEFAULT '' AFTER template_class_id,
  ADD KEY idx_pools_sku (sku_id);
