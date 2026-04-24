ALTER TABLE users
  ADD COLUMN realname_verified_at DATETIME(6) NULL AFTER invite_required,
  ADD COLUMN realname_verify_provider VARCHAR(32) NOT NULL DEFAULT 'tencent_faceid' AFTER realname_verified_at,
  ADD COLUMN realname_verify_result VARCHAR(32) NULL AFTER realname_verify_provider,
  ADD COLUMN realname_request_id VARCHAR(128) NULL AFTER realname_verify_result,
  ADD COLUMN realname_name_ciphertext TEXT NULL AFTER realname_request_id,
  ADD COLUMN realname_id_card_ciphertext TEXT NULL AFTER realname_name_ciphertext,
  ADD COLUMN realname_name_masked VARCHAR(64) NULL AFTER realname_id_card_ciphertext,
  ADD COLUMN realname_id_card_masked VARCHAR(32) NULL AFTER realname_name_masked;
