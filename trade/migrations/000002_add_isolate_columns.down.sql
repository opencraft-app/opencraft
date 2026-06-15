-- trade migration 0002 down：回滚 isolate 列（演练 / 灾难恢复用）。
--
-- 注意：
--   - 如果生产已有 isolate flow_type 行（resource_id / uin 非空），down 会丢失这些列数据；
--     仅在确认 trade_flow 全部为 createResource 链路存量时才能安全回滚。
--   - deal_name 的 NULL 兼容性回退会把存量 isolate 行 deal_name=NULL 强行变成 NOT NULL；
--     若存量已有 isolate 行先 DELETE 再 ALTER 才安全。

ALTER TABLE trade_flow
    DROP KEY idx_resource_isolate,
    DROP COLUMN uin,
    DROP COLUMN resource_id;

ALTER TABLE trade_flow MODIFY COLUMN deal_name VARCHAR(64) NOT NULL
    COMMENT 'jifei dealName（Q56 反查兜底键）';
