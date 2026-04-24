ALTER TABLE pools
  DROP KEY idx_pools_sku,
  DROP COLUMN sku_id;

DROP TABLE IF EXISTS template_sku_bindings;
DROP TABLE IF EXISTS skus;
