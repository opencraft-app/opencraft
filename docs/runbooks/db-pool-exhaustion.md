# DBPoolExhaustion

检查 `openclaw_db_pool_in_use`、`openclaw_db_pool_wait_total` 与慢 SQL/锁等待，确认是连接泄漏、瞬时并发升高还是某些查询退化导致连接池耗尽。
