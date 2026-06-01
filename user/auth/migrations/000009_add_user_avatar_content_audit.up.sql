ALTER TABLE users
  ADD COLUMN pending_avatar_object_key VARCHAR(512) NULL AFTER avatar_source,
  ADD COLUMN pending_avatar_source VARCHAR(32) NULL AFTER pending_avatar_object_key,
  ADD COLUMN avatar_audit_status VARCHAR(32) NULL AFTER pending_avatar_source;

ALTER TABLE content_audit_tasks
  ADD COLUMN content_url VARCHAR(2048) NULL AFTER content_text,
  ADD COLUMN media_type VARCHAR(32) NOT NULL DEFAULT 'text' AFTER content_url;
