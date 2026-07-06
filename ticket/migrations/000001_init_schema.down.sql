-- 000001_init_schema.down.sql
-- LightVela Ticket System v1 回滚
--
-- 外键依赖关系：
--   ticket_message.ticket_id  → ticket.id    (fk_ticket_message_ticket, ON DELETE CASCADE)
--   ticket_audit_log.ticket_id → ticket.id   (fk_ticket_audit_ticket, ON DELETE CASCADE)
--
-- 删除顺序：先删子表（ticket_message、ticket_audit_log），再删主表（ticket）。
-- 即使有 ON DELETE CASCADE，显式按依赖顺序删除更安全且可移植。
-- 外围包裹 SET FOREIGN_KEY_CHECKS 防止极端情况下 FK 约束导致 DROP 失败。

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `ticket_audit_log`;
DROP TABLE IF EXISTS `ticket_message`;
DROP TABLE IF EXISTS `ticket`;

SET FOREIGN_KEY_CHECKS = 1;
