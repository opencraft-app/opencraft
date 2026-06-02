ALTER TABLE content_audit_tasks
  DROP COLUMN media_type,
  DROP COLUMN content_url;

ALTER TABLE users
  DROP COLUMN avatar_audit_status,
  DROP COLUMN pending_avatar_source,
  DROP COLUMN pending_avatar_object_key;
