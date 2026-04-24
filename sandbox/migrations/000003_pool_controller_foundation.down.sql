ALTER TABLE sandboxes
  DROP COLUMN resolution_divergence,
  DROP COLUMN resolution_source,
  DROP COLUMN resolution_mode,
  DROP COLUMN template_class_id;

ALTER TABLE pools
  DROP KEY idx_pools_capacity_bundle,
  DROP KEY idx_pools_template_class,
  DROP COLUMN last_health_transition_at,
  DROP COLUMN last_autoscale_action,
  DROP COLUMN autoscale_generation,
  DROP COLUMN capacity_bundle_id,
  DROP COLUMN max_capacity,
  DROP COLUMN capacity_state,
  DROP COLUMN template_class_id;

DROP TABLE IF EXISTS capacity_bundles;
DROP TABLE IF EXISTS pool_autoscale_policies;
DROP TABLE IF EXISTS template_pool_bindings;
DROP TABLE IF EXISTS template_classes;
