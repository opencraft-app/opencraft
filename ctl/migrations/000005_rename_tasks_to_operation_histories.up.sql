-- 重命名表
RENAME TABLE tasks TO operation_histories;

-- 重命名列
ALTER TABLE operation_histories
    CHANGE COLUMN task_id operation_id VARCHAR(64) NOT NULL,
    CHANGE COLUMN task_type operation_type VARCHAR(32) NOT NULL;

-- 重命名索引（MySQL 5.7+ 支持 RENAME INDEX）
ALTER TABLE operation_histories
    RENAME INDEX uk_task_id TO uk_operation_id;
