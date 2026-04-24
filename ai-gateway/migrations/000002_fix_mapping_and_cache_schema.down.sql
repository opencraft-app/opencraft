-- Best-effort rollback.

SET @has_model_mappings := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'model_mappings'
);
SET @has_model_provider_mappings := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'model_provider_mappings'
);
SET @rename_mapping_sql := IF(
  @has_model_mappings = 1 AND @has_model_provider_mappings = 0,
  'RENAME TABLE model_mappings TO model_provider_mappings',
  'SELECT 1'
);
PREPARE stmt FROM @rename_mapping_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
