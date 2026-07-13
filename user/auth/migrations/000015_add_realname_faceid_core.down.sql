DROP TABLE IF EXISTS realname_faceid_audit_events;
DROP TABLE IF EXISTS realname_faceid_attempts;

ALTER TABLE shadow_bindings
  DROP KEY idx_shadow_bindings_basic_auth_source_attempt_id,
  DROP COLUMN basic_auth_phone_hash,
  DROP COLUMN basic_auth_identity_hash,
  DROP COLUMN basic_auth_source_attempt_id;

ALTER TABLE users
  DROP KEY idx_users_realname_final_attempt_id,
  DROP COLUMN realname_phone_hash,
  DROP COLUMN realname_identity_hash,
  DROP COLUMN realname_phone_verified_at,
  DROP COLUMN realname_face_verified_at,
  DROP COLUMN realname_final_attempt_id;
