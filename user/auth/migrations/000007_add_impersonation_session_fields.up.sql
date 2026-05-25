ALTER TABLE auth_sessions
  ADD COLUMN impersonated TINYINT(1) NOT NULL DEFAULT 0 AFTER plan_confirmed_at,
  ADD COLUMN impersonation_reason VARCHAR(512) NULL AFTER impersonated;
