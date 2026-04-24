# TaskFailureRateHigh

检查 `task_failed_total` 是否集中在单一 `task`，再对照 `openclaw_task_status_total` 和对应 service 日志确认是代码回归、依赖异常还是补偿堆积。
