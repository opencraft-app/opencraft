ALTER TABLE shadow_bindings
  ADD COLUMN basic_auth_status VARCHAR(32) NULL AFTER last_error_message,
  ADD COLUMN basic_auth_synced_at DATETIME(6) NULL AFTER basic_auth_status,
  ADD COLUMN basic_auth_last_error_code VARCHAR(128) NULL AFTER basic_auth_synced_at,
  ADD COLUMN basic_auth_last_error_message TEXT NULL AFTER basic_auth_last_error_code,
  ADD KEY idx_shadow_bindings_basic_auth_status (basic_auth_status);
