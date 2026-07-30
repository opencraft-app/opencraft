USE lightclaw_auth;

INSERT INTO invites (code, state, message, created_at, updated_at)
VALUES
  ('VALID2026', 'valid', 'Local dev invite is valid.', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('EXPIRED2026', 'expired', 'Local dev invite is expired.', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('USED2026', 'used', 'Local dev invite has already been used.', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
ON DUPLICATE KEY UPDATE
  state = VALUES(state),
  message = VALUES(message),
  updated_at = CURRENT_TIMESTAMP(6);
