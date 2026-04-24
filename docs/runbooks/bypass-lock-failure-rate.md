# BypassLockFailureRate

确认是否存在重复部署或多实例异常竞争同一 bypass 锁；如果锁竞争持续升高，检查 bypass 副本数、锁 TTL 和单轮执行时长是否合理。
