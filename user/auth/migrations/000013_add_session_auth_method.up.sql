ALTER TABLE auth_sessions
  ADD COLUMN auth_method VARCHAR(16) NOT NULL DEFAULT 'unknown' AFTER impersonation_reason;
