-- 恢复索引名
ALTER TABLE operation_histories
    RENAME INDEX uk_operation_id TO uk_task_id;

-- 恢复列名
ALTER TABLE operation_histories
    CHANGE COLUMN operation_id task_id VARCHAR(64) NOT NULL,
    CHANGE COLUMN operation_type task_type VARCHAR(32) NOT NULL;

-- 恢复表名
RENAME TABLE operation_histories TO tasks;
