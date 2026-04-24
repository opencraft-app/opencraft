SET @drop_avatar_source = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'avatar_source'
    ),
    'ALTER TABLE users DROP COLUMN avatar_source',
    'SELECT 1'
  )
);
PREPARE drop_avatar_source_stmt FROM @drop_avatar_source;
EXECUTE drop_avatar_source_stmt;
DEALLOCATE PREPARE drop_avatar_source_stmt;

SET @drop_avatar_object_key = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name = 'avatar_object_key'
    ),
    'ALTER TABLE users DROP COLUMN avatar_object_key',
    'SELECT 1'
  )
);
PREPARE drop_avatar_object_key_stmt FROM @drop_avatar_object_key;
EXECUTE drop_avatar_object_key_stmt;
DEALLOCATE PREPARE drop_avatar_object_key_stmt;
