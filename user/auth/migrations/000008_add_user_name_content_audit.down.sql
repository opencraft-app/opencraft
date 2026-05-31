DROP TABLE IF EXISTS content_audit_tasks;

ALTER TABLE users
  DROP COLUMN name_audit_status,
  DROP COLUMN pending_name;
