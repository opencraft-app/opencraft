ALTER TABLE auth_sessions
  DROP COLUMN impersonation_reason,
  DROP COLUMN impersonated;
