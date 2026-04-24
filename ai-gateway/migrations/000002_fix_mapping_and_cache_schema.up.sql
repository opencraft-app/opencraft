-- Align runtime schema with application expectations.

-- Ensure model mappings use the application table name.
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
  @has_model_provider_mappings = 1 AND @has_model_mappings = 0,
  'RENAME TABLE model_provider_mappings TO model_mappings',
  'SELECT 1'
);
PREPARE stmt FROM @rename_mapping_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure response_cache.id has a UUID value when rows are inserted manually.
SET @has_response_cache := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'response_cache'
);
SET @alter_response_cache_sql := IF(
  @has_response_cache = 1,
  'ALTER TABLE response_cache MODIFY COLUMN id char(36) NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @alter_response_cache_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
