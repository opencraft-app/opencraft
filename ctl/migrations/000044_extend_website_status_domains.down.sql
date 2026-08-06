ALTER TABLE `website_sites`
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'creating'
        COMMENT 'creating/active/suspended/deleted';

ALTER TABLE `website_operations`
    MODIFY COLUMN `operation_type` VARCHAR(32) NOT NULL
        COMMENT 'create/deploy/delete',
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'created'
        COMMENT 'created/running/success/failed';
