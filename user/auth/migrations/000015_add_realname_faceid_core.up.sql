ALTER TABLE users
  ADD COLUMN realname_final_attempt_id VARCHAR(64) NULL AFTER realname_level,
  ADD COLUMN realname_face_verified_at DATETIME(6) NULL AFTER realname_final_attempt_id,
  ADD COLUMN realname_phone_verified_at DATETIME(6) NULL AFTER realname_face_verified_at,
  ADD COLUMN realname_identity_hash CHAR(64) NULL AFTER realname_phone_verified_at,
  ADD COLUMN realname_phone_hash CHAR(64) NULL AFTER realname_identity_hash,
  ADD KEY idx_users_realname_final_attempt_id (realname_final_attempt_id);

ALTER TABLE shadow_bindings
  ADD COLUMN basic_auth_source_attempt_id VARCHAR(64) NULL AFTER basic_auth_synced_at,
  ADD COLUMN basic_auth_identity_hash CHAR(64) NULL AFTER basic_auth_source_attempt_id,
  ADD COLUMN basic_auth_phone_hash CHAR(64) NULL AFTER basic_auth_identity_hash,
  ADD KEY idx_shadow_bindings_basic_auth_source_attempt_id (basic_auth_source_attempt_id);

CREATE TABLE IF NOT EXISTS realname_faceid_attempts (
  attempt_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL,
  name_ciphertext TEXT NULL,
  id_card_ciphertext TEXT NULL,
  name_masked VARCHAR(64) NULL,
  id_card_masked VARCHAR(32) NULL,
  identity_hash CHAR(64) NOT NULL,
  current_phone_hash CHAR(64) NOT NULL,
  phone_verified_hash CHAR(64) NULL,
  biz_token_ciphertext TEXT NULL,
  biz_token_hash CHAR(64) NULL,
  verify_url_ciphertext TEXT NULL,
  rule_id VARCHAR(128) NULL,
  account_id VARCHAR(128) NULL,
  provider_extra VARCHAR(1024) NULL,
  detect_auth_request_id VARCHAR(128) NULL,
  last_get_info_request_id VARCHAR(128) NULL,
  face_verified_at DATETIME(6) NULL,
  phone_verified_at DATETIME(6) NULL,
  business_expires_at DATETIME(6) NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_until DATETIME(6) NULL,
  lease_version BIGINT NOT NULL DEFAULT 0,
  client_ip_ciphertext TEXT NULL,
  client_ua_ciphertext TEXT NULL,
  scrubbed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_realname_faceid_attempts_biz_token_hash (biz_token_hash),
  KEY idx_realname_faceid_attempts_user_created (user_id, created_at),
  KEY idx_realname_faceid_attempts_user_state (user_id, state),
  KEY idx_realname_faceid_attempts_lease (state, lease_until),
  KEY idx_realname_faceid_attempts_identity_phone (user_id, identity_hash, current_phone_hash, business_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS realname_faceid_audit_events (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  attempt_id VARCHAR(64) NULL,
  user_id VARCHAR(64) NULL,
  event_type VARCHAR(64) NOT NULL,
  state VARCHAR(32) NULL,
  rule_id VARCHAR(128) NULL,
  account_id VARCHAR(128) NULL,
  request_id VARCHAR(128) NULL,
  identity_hash CHAR(64) NULL,
  phone_hash CHAR(64) NULL,
  biz_token_hash CHAR(64) NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_realname_faceid_audit_attempt_created (attempt_id, created_at),
  KEY idx_realname_faceid_audit_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
