-- =============================================================================
-- AI Gateway MySQL Schema - Rollback
-- 回滚 000001_init_schema.up.sql 的所有变更
-- =============================================================================

DROP TABLE IF EXISTS response_cache;
DROP TABLE IF EXISTS runtime_configs;
DROP TABLE IF EXISTS admin_audit_logs;
DROP TABLE IF EXISTS usage_logs;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS model_provider_mappings;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS users;
