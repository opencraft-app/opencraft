DROP TABLE IF EXISTS email_bind_tokens;

ALTER TABLE users
  DROP COLUMN email_verified;
