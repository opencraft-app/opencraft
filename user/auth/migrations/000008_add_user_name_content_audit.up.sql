ALTER TABLE users
  ADD COLUMN pending_name VARCHAR(255) NULL AFTER name,
  ADD COLUMN name_audit_status VARCHAR(32) NULL AFTER pending_name;

CREATE TABLE IF NOT EXISTS content_audit_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  biz_type VARCHAR(64) NOT NULL,
  biz_id VARCHAR(64) NOT NULL,
  biz_detail VARCHAR(128) NULL,
  product_id VARCHAR(64) NOT NULL,
  sid VARCHAR(64) NOT NULL,
  content_digest VARCHAR(255) NULL,
  content_text TEXT NULL,
  status VARCHAR(32) NOT NULL,
  request_id VARCHAR(128) NULL,
  result_code INT NULL,
  result_type INT NULL,
  result_detail TEXT NULL,
  pass_source VARCHAR(32) NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(512) NULL,
  submitted_at DATETIME(6) NULL,
  audited_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY idx_content_audit_pending (status, attempts, created_at),
  KEY idx_content_audit_request_id (request_id),
  KEY idx_content_audit_biz (biz_type, biz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
