ALTER TABLE shadow_bindings
  DROP KEY idx_shadow_bindings_basic_auth_status,
  DROP COLUMN basic_auth_last_error_message,
  DROP COLUMN basic_auth_last_error_code,
  DROP COLUMN basic_auth_synced_at,
  DROP COLUMN basic_auth_status;
