CREATE TABLE IF NOT EXISTS credit_package_id_allocation (
    id           BIGINT       PRIMARY KEY AUTO_INCREMENT,
    deal_name    VARCHAR(128) NOT NULL UNIQUE,
    created_time DATETIME     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='credit package resource ID allocation';
