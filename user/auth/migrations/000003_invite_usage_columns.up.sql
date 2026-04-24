ALTER TABLE invites
  ADD COLUMN used_by_user_id VARCHAR(64) NULL AFTER message,
  ADD COLUMN used_via VARCHAR(32) NULL AFTER used_by_user_id,
  ADD COLUMN used_at DATETIME(6) NULL AFTER used_via;
