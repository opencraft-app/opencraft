-- 把 superseded 回滚为 active（恢复到「多版本同时 active」的旧状态）
UPDATE `website_releases` SET `status` = 'active' WHERE `status` = 'superseded';

ALTER TABLE `website_releases`
    MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'pending'
        COMMENT 'pending/uploading/deploying/active/failed/rolled_back';
