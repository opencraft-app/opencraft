SET @add_avatar_object_key = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'avatar_object_key'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN avatar_object_key VARCHAR(512) NULL'
  )
);
PREPARE add_avatar_object_key_stmt FROM @add_avatar_object_key;
EXECUTE add_avatar_object_key_stmt;
DEALLOCATE PREPARE add_avatar_object_key_stmt;

SET @add_avatar_source = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'avatar_source'
    ),
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN avatar_source VARCHAR(32) NULL'
  )
);
PREPARE add_avatar_source_stmt FROM @add_avatar_source;
EXECUTE add_avatar_source_stmt;
DEALLOCATE PREPARE add_avatar_source_stmt;
