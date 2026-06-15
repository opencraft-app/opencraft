-- 新增 bundle.instance_spec_id 列：bundle 与实例规格（CPU/内存/系统盘）多对一关联
--
-- 设计稿：.tmp/bundle-instance-spec-design.md
--   - Q1=a：实例规格抽象层采用代码常量字典（ctl/pkg/model/instancespec），不新建 DB 字典表
--   - Q4=a：bundle 表新增单列 instance_spec_id VARCHAR(64)（一对一）
--   - Q10=a：部署时同步回填存量 bundle 为 spec-2c4g50g（避免 NULL 走 fallback）
--
-- 业务语义（DB COMMENT 同步说明）：
--   - DB 内部字段，唯一消费方 ctl/instance.RunCreateInstanceTask 反查 bundle 选 per-spec 候选池
--   - user-facing / internal-facing / admin 出参均通过 SpecDefinition 常量字典展开为
--     cpu / memory / system_disk_size 三个量化字段（不直接暴露 spec_id 给 trade / 前端）
--   - NULL = 兼容期 fallback 到全局 default_template_id（设计稿 §4.3 候选 A）

ALTER TABLE `bundle`
    ADD COLUMN `instance_spec_id` VARCHAR(64) NULL DEFAULT NULL
    COMMENT '实例规格 ID（DB 内部字段；NULL 时兼容期 fallback 到全局默认 spec-2c4g50g）'
    AFTER `ai_gateway_plans`;

-- 存量回填（Q10=a）：所有现网 bundle 都是 2C4G50G 规格，显式刷成 spec-2c4g50g
-- 与 ctl/pkg/model/instancespec/spec.go::KnownSpecs 中的 "spec-2c4g50g" 保持一致。
UPDATE `bundle`
SET `instance_spec_id` = 'spec-2c4g50g'
WHERE `instance_spec_id` IS NULL;
