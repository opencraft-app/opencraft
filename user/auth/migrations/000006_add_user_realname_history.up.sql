CREATE TABLE IF NOT EXISTS user_realname_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  realname_verified_at DATETIME(6) NOT NULL,
  realname_verify_provider VARCHAR(32) NOT NULL,
  realname_verify_result VARCHAR(32) NULL,
  realname_request_id VARCHAR(128) NULL,
  realname_name_ciphertext TEXT NOT NULL,
  realname_id_card_ciphertext TEXT NOT NULL,
  realname_name_masked VARCHAR(64) NOT NULL,
  realname_id_card_masked VARCHAR(32) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_user_realname_history_user_id (user_id),
  KEY idx_user_realname_history_created_at (created_at),
  CONSTRAINT fk_user_realname_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
