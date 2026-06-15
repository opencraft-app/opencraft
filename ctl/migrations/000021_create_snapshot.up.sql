-- 新建 snapshot 表（trade-pass-destroy 设计稿 §4.4 落地，Q9-fix v0.10 修订）
--
-- 拍板依据：.tmp/trade-pass-destroy-design.md §4.4 / §11-A Q4-a / Q9 / Q9-fix / Q21
--
-- 用途：销毁链路子 task 创建/轮询系统盘快照后落库的 snapshot 业务实体表
--   - 与 instance 表并列，是 ctl 顶级业务模型，跨云厂商/底层存储不变
--   - sandbox 仅作无状态执行层，把 ctl 的 snapshot 请求转译为底层（当前 cbs）调用
--
-- 字段含义（与 ctl/pkg/model/snapshot/entity.go Entity 一一对应）：
--   - snapshot_id：物理快照 ID（当前来源 cbs SnapshotId，形如 snap-xxxxxxxx）
--   - flow_id：sandbox CreateSnapshot 返回的异步任务 flow id（int64）
--   - pass_id / instance_id / user_id / uin / app_id：销毁事件归属维度，镜像自 pass / instance 表
--   - region：ctl 进程配置 config.ServerConf.MiscConfig.Region（Q21 拍板）
--   - snapshot_state：业务状态枚举 in_progress / ready / failed（已抽象，不暴露 cbs 原生枚举）
--   - expire_time：快照过期时刻（用于后续清理 / 容量水位计算）
--
-- 索引设计（与 GORM tag 严格对齐）：
--   - uk_snapshot_id (snapshot_id)：UNIQUE，物理快照 ID 全局唯一
--   - uk_flow_instance (flow_id, instance_id)：UNIQUE，销毁事件维度唯一（Q9-fix）
--     避免同 instance_id 反复 ALLOCATE/Release 时第二次销毁主键冲突
--   - idx_snapshot_pass_id (pass_id)：按 pass 反查销毁历史
--   - idx_snapshot_instance_id (instance_id)：按实例反查全部销毁历史（非唯一）
--   - idx_snapshot_user_id (user_id)：按用户反查销毁历史
--   - idx_snapshot_expire_time (expire_time)：按过期时刻扫描清理
CREATE TABLE IF NOT EXISTS `snapshot` (
    `id`              BIGINT       NOT NULL AUTO_INCREMENT,
    `snapshot_id`     VARCHAR(64)  NOT NULL                    COMMENT '物理快照 ID（当前来源 cbs SnapshotId）',
    `flow_id`         BIGINT       NOT NULL                    COMMENT 'sandbox CreateSnapshot 返回的异步任务 flow id',
    `pass_id`         VARCHAR(64)  NOT NULL                    COMMENT '销毁事件归属 pass（镜像自 pass 表）',
    `instance_id`     VARCHAR(64)  NOT NULL                    COMMENT '销毁事件归属 instance（镜像自 instance 表）',
    `user_id`         VARCHAR(64)  NOT NULL                    COMMENT '销毁事件归属用户',
    `uin`             BIGINT       NOT NULL                    COMMENT '腾讯云用户账号（镜像自 pass / shadow binding）',
    `app_id`          BIGINT       NOT NULL                    COMMENT '腾讯云应用 ID（镜像自 pass / shadow binding）',
    `region`          VARCHAR(32)  NOT NULL DEFAULT ''         COMMENT 'Q21 ✅ 来源 ctl config.ServerConf.MiscConfig.Region',
    `snapshot_state`  VARCHAR(16)  NOT NULL DEFAULT ''         COMMENT '业务状态枚举：in_progress / ready / failed',
    `expire_time`     DATETIME     NOT NULL                    COMMENT '快照过期时刻',
    `created_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_time`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_snapshot_id` (`snapshot_id`),
    UNIQUE KEY `uk_flow_instance` (`flow_id`, `instance_id`),
    KEY `idx_snapshot_pass_id` (`pass_id`),
    KEY `idx_snapshot_instance_id` (`instance_id`),
    KEY `idx_snapshot_user_id` (`user_id`),
    KEY `idx_snapshot_expire_time` (`expire_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
