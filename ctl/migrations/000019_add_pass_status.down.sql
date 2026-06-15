-- 回滚 000019：删除 pass.status 列及索引
DROP INDEX `idx_status` ON `pass`;
ALTER TABLE `pass` DROP COLUMN `status`;
