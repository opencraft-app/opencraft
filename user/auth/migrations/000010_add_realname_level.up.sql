ALTER TABLE users
  ADD COLUMN realname_level VARCHAR(32) NOT NULL DEFAULT 'none' AFTER realname_verified_at;

UPDATE users
SET realname_level = 'idcard_2fa'
WHERE realname_verified_at IS NOT NULL;
