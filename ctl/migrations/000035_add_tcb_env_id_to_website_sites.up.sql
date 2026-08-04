-- 新增 tcb_env_id 列，记录站点部署到哪个 TCB 环境
ALTER TABLE `website_sites`
    ADD COLUMN `tcb_env_id` VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'TCB环境ID' AFTER `cloud_path`;
