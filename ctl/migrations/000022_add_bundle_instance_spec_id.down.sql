-- 回滚 bundle.instance_spec_id 列
-- 与 000022_add_bundle_instance_spec_id.up.sql 对称
ALTER TABLE `bundle` DROP COLUMN `instance_spec_id`;
