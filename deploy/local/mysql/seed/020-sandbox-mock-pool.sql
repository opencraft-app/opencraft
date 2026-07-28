USE sandbox;

INSERT INTO template_classes (
  id,
  name,
  description,
  workload_type,
  region,
  default_pool_selection_policy,
  resolution_mode,
  status,
  import_generation,
  divergence_message,
  created_at,
  updated_at
)
VALUES (
  'openclaw-default',
  'OpenClaw local default',
  'Single-node local mock template class',
  'mock',
  'local',
  'priority',
  'sandbox_primary',
  'active',
  1,
  NULL,
  CURRENT_TIMESTAMP(6),
  CURRENT_TIMESTAMP(6)
)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  workload_type = VALUES(workload_type),
  region = VALUES(region),
  resolution_mode = VALUES(resolution_mode),
  status = VALUES(status),
  updated_at = CURRENT_TIMESTAMP(6);

INSERT INTO skus (
  id,
  name,
  description,
  template_class_id,
  base_image,
  desired_image_id,
  stable_image_id,
  instance_type,
  network_template_id,
  security_group_rule_template_id,
  autoscale_policy_id,
  default_desired_capacity,
  rollout_state,
  rollout_cursor_pool_id,
  generation,
  converged_pool_count,
  total_pool_count,
  pools_pending_rollout,
  last_rollout_started_at,
  last_rollout_error,
  created_at,
  updated_at
)
VALUES (
  'sku-local-default',
  'Local default SKU',
  'Single-node local mock SKU',
  'openclaw-default',
  'img-local-default',
  'img-local-default',
  'img-local-default',
  'LOCAL.MOCK',
  'net-local',
  '',
  '',
  5,
  'stable',
  '',
  1,
  5,
  5,
  0,
  NULL,
  NULL,
  CURRENT_TIMESTAMP(6),
  CURRENT_TIMESTAMP(6)
)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  base_image = VALUES(base_image),
  desired_image_id = VALUES(desired_image_id),
  stable_image_id = VALUES(stable_image_id),
  instance_type = VALUES(instance_type),
  rollout_state = VALUES(rollout_state),
  updated_at = CURRENT_TIMESTAMP(6);

INSERT INTO pools (
  id,
  name,
  description,
  base_image,
  desired_capacity,
  instance_type,
  status,
  pause_reason,
  consecutive_refill_failures,
  last_refill_error_code,
  last_refill_error,
  vpc_id,
  subnet_id,
  zone,
  security_groups,
  template_class_id,
  sku_id,
  capacity_state,
  max_capacity,
  capacity_bundle_id,
  autoscale_generation,
  last_autoscale_action,
  last_health_transition_at,
  system_disk_size,
  created_at
)
VALUES (
  'pool-local-default',
  'local-default',
  'Single-node local mock pool',
  'img-local-default',
  5,
  'LOCAL.MOCK',
  'active',
  NULL,
  0,
  '',
  NULL,
  'vpc-local',
  'subnet-local',
  'local-1',
  'sg-local',
  'openclaw-default',
  'sku-local-default',
  'active',
  5,
  '',
  1,
  'seed',
  NULL,
  50,
  CURRENT_TIMESTAMP(6)
)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  base_image = VALUES(base_image),
  desired_capacity = VALUES(desired_capacity),
  instance_type = VALUES(instance_type),
  status = VALUES(status),
  vpc_id = VALUES(vpc_id),
  subnet_id = VALUES(subnet_id),
  zone = VALUES(zone),
  security_groups = VALUES(security_groups),
  template_class_id = VALUES(template_class_id),
  sku_id = VALUES(sku_id),
  capacity_state = VALUES(capacity_state),
  max_capacity = VALUES(max_capacity),
  autoscale_generation = VALUES(autoscale_generation),
  last_autoscale_action = VALUES(last_autoscale_action),
  system_disk_size = VALUES(system_disk_size);

INSERT INTO template_sku_bindings (
  template_class_id,
  sku_id,
  priority,
  weight,
  admission_state,
  region_affinity,
  rollout_eligibility,
  created_at,
  updated_at
)
VALUES (
  'openclaw-default',
  'sku-local-default',
  100,
  1,
  'active',
  '',
  TRUE,
  CURRENT_TIMESTAMP(6),
  CURRENT_TIMESTAMP(6)
)
ON DUPLICATE KEY UPDATE
  priority = VALUES(priority),
  weight = VALUES(weight),
  admission_state = VALUES(admission_state),
  rollout_eligibility = VALUES(rollout_eligibility),
  updated_at = CURRENT_TIMESTAMP(6);

INSERT INTO template_pool_bindings (
  template_class_id,
  pool_id,
  priority,
  weight,
  role,
  admission_state,
  reason,
  created_at,
  updated_at
)
VALUES (
  'openclaw-default',
  'pool-local-default',
  100,
  1,
  'primary',
  'active',
  '',
  CURRENT_TIMESTAMP(6),
  CURRENT_TIMESTAMP(6)
)
ON DUPLICATE KEY UPDATE
  priority = VALUES(priority),
  weight = VALUES(weight),
  role = VALUES(role),
  admission_state = VALUES(admission_state),
  reason = VALUES(reason),
  updated_at = CURRENT_TIMESTAMP(6);

INSERT INTO instances (
  id,
  pool_id,
  state,
  cloud_id,
  address,
  created_at,
  updated_at
)
VALUES
  (
    'inst-local-clean-1',
    'pool-local-default',
    'CLEAN',
    'cvm-local-clean-1',
    '10.99.0.10',
    CURRENT_TIMESTAMP(6),
    CURRENT_TIMESTAMP(6)
  ),
  (
    'inst-local-clean-2',
    'pool-local-default',
    'CLEAN',
    'cvm-local-clean-2',
    '10.99.0.11',
    CURRENT_TIMESTAMP(6),
    CURRENT_TIMESTAMP(6)
  ),
  (
    'inst-local-clean-3',
    'pool-local-default',
    'CLEAN',
    'cvm-local-clean-3',
    '10.99.0.12',
    CURRENT_TIMESTAMP(6),
    CURRENT_TIMESTAMP(6)
  ),
  (
    'inst-local-clean-4',
    'pool-local-default',
    'CLEAN',
    'cvm-local-clean-4',
    '10.99.0.13',
    CURRENT_TIMESTAMP(6),
    CURRENT_TIMESTAMP(6)
  ),
  (
    'inst-local-clean-5',
    'pool-local-default',
    'CLEAN',
    'cvm-local-clean-5',
    '10.99.0.14',
    CURRENT_TIMESTAMP(6),
    CURRENT_TIMESTAMP(6)
  )
ON DUPLICATE KEY UPDATE
  pool_id = VALUES(pool_id),
  state = IF(state IN ('CLEAN', 'DRY', 'FAILED', 'DELETED'), VALUES(state), state),
  cloud_id = VALUES(cloud_id),
  address = VALUES(address),
  updated_at = CURRENT_TIMESTAMP(6);
