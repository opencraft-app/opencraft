-- 新增 pools.system_disk_size 列：sandbox 侧承载实例规格的系统盘大小维度
--
-- 设计稿：.tmp/bundle-instance-spec-design.md §10 Q11=a
--
-- 背景：v2 校准发现 tencent.go::CreateInstance() 完全不设 req.SystemDisk，
-- 导致现网所有 pool 出来的 CVM 系统盘都是腾讯云默认的 50G。多规格上线后必须由
-- pool 自描述系统盘大小，让 tencent provider 在 RunInstances 时显式下发
-- SystemDisk.DiskSize。
--
-- 字段语义：
--   - >0：在 RunInstances 时设 req.SystemDisk = &cvm.SystemDisk{DiskSize: <val>}
--   - 0  ：走腾讯云默认 50G（与现网行为一致，兼容期 fallback）

ALTER TABLE pools
    ADD COLUMN system_disk_size INT NOT NULL DEFAULT 50
    COMMENT '系统盘大小（GB），0 时走腾讯云默认 50G';
