CREATE TABLE IF NOT EXISTS pool_supply_overview (
  region VARCHAR(32) NOT NULL,
  zone VARCHAR(32) NOT NULL,
  instance_type VARCHAR(64) NOT NULL,
  resource_count BIGINT UNSIGNED NULL,
  sales_state ENUM('active', 'pause') NOT NULL,
  request_id VARCHAR(64) NOT NULL DEFAULT '',
  updated_time DATETIME(6) NULL,
  PRIMARY KEY (region, zone, instance_type)
);
