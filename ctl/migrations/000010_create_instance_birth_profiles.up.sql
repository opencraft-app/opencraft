CREATE TABLE IF NOT EXISTS instance_birth_profiles (
  id BIGINT NOT NULL AUTO_INCREMENT,
  instance_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  sandbox_id VARCHAR(128) NOT NULL DEFAULT '',
  created_at_utc DATETIME(3) NOT NULL,
  born_date_for_china VARCHAR(10) NOT NULL,
  born_number_for_china INT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_instance_id (instance_id),
  KEY idx_birth_date_number (born_date_for_china, born_number_for_china),
  KEY idx_birth_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
