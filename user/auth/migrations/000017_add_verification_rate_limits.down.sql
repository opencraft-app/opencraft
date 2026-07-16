ALTER TABLE phone_auth_challenges
  DROP COLUMN reservation_id,
  DROP COLUMN generation;

ALTER TABLE sms_challenges
  DROP COLUMN reservation_id,
  DROP COLUMN generation;

DROP TABLE IF EXISTS verification_rate_limits;
