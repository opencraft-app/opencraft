CREATE TABLE IF NOT EXISTS tasks (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    task_id      VARCHAR(64)  NOT NULL,
    task_type    VARCHAR(32)  NOT NULL,
    instance_id  VARCHAR(64)  NOT NULL,
    user_id      VARCHAR(64)  NOT NULL,
    status       VARCHAR(16)  NOT NULL DEFAULT 'CREATED',
    error_message VARCHAR(2048) DEFAULT NULL,
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_task_id (task_id),
    KEY idx_instance_user (instance_id, user_id),
    KEY idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
