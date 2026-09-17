USE ctl;

UPDATE bundle
SET bundle_state = 'OFFLINE'
WHERE bundle_id IN ('bundle_free_trial_local', 'bundle_general_local');

INSERT INTO bundle (
  bundle_id, bundle_type, bundle_name, description, bundle_state,
  agent_quota, credit, time_span, time_unit, ai_gateway_plan_id,
  ai_gateway_plans, instance_spec_id, static_sold_out,
  bundle_sales_available_count, bundle_sales_total_count
) VALUES
  (
    'bundle_launch_01', 'general', '启航',
    '[{"Key":"Runtime","Value":"国内计费测试"},{"Key":"Tier","Value":"启航"}]',
    'ONLINE', 1, 0, 1, 'm', '00000000-0000-4000-8000-000000000001',
    NULL, 'spec-2c4g50g', 0, 1000, 1000
  ),
  (
    'bundle_cruise_01', 'general', '巡航',
    '[{"Key":"Runtime","Value":"国内计费测试"},{"Key":"Tier","Value":"巡航"}]',
    'ONLINE', 1, 0, 1, 'm', '00000000-0000-4000-8000-000000000001',
    NULL, 'spec-4c8g80g', 0, 1000, 1000
  )
ON DUPLICATE KEY UPDATE
  bundle_type=VALUES(bundle_type), bundle_name=VALUES(bundle_name),
  description=VALUES(description), bundle_state=VALUES(bundle_state),
  agent_quota=VALUES(agent_quota), credit=VALUES(credit),
  time_span=VALUES(time_span), time_unit=VALUES(time_unit),
  ai_gateway_plan_id=VALUES(ai_gateway_plan_id), ai_gateway_plans=VALUES(ai_gateway_plans),
  instance_spec_id=VALUES(instance_spec_id), static_sold_out=VALUES(static_sold_out),
  bundle_sales_available_count=VALUES(bundle_sales_available_count),
  bundle_sales_total_count=VALUES(bundle_sales_total_count);
