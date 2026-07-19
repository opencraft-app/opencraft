# Worker Pool 横向扩展设计

## 目标

将现有单一 `llmgateway-worker` 拆成可独立扩容的 `core`、`byok`、`observer` 三类运行池，同时保持同一代码库、同一镜像和同一 LLMGateway MySQL 真源。拆分后不按 Shard 固定绑定 worker；Set 是 new-api 管理请求的主要限流边界，Shard 只提供更高层的数据库预算。

## 运行池

| Pool | 职责 | 并发语义 |
| --- | --- | --- |
| `core` | Set facts、容量决策、准入、渠道漂移、清理 | 任务名级 MySQL lease，允许多副本热备，同名任务全局单例 |
| `byok` | 用户 BYOK 配置同步 | 用户任务级 lease，多副本并行；同一用户串行、同一 Set 有界并发 |
| `observer` | 租户权益投影刷新 | 用户任务级 lease，多副本并行；按 Set 公平调度和限流 |

进程通过 `LLMGATEWAY_WORKER_POOL=core|byok|observer` 选择运行模式。默认值保持 `core`，避免旧部署意外同时启动全部消费者。

## BYOK 状态机

`llmgateway_byok_sync_tasks` 继续作为意图合并和消费真源。保存设置只递增 `requested_version`；消费者领取时把该值冻结到 `processing_version`。完成时若发现新版本已到达，任务回到 `pending`，否则进入 `succeeded`。

候选任务必须包含 `pending`、到期 `error` 和 lease 已过期的 `running`。任务执行期间周期续租；续租失败立即取消远端请求。进程退出时停止领取新任务，并将仍由自己持有的任务释放为可重试状态。

BYOK 消费按 Set 公平领取，避免单个 Set 的积压饿死其他 Set。候选查询会排除当前 worker 副本内已占满并发槽的 Set，再从后续 Set 领取任务；它不扫描完整 Set 列表，也不把本地槽位当成跨 Pod 真源。跨 Pod 的并发限制复用 `llmgateway_set_operation_leases`：普通 BYOK 同步使用多个 slot，`GroupRatio` 更新固定使用一个 slot。

## `GroupRatio` 所有权

`byok_` 是系统保留前缀，平台渠道包不得声明该前缀的 group。

- `llmgateway_group_ratio_desired` 是唯一合并真源，平台 group 和用户 `byok_* = 0` 都以行级意图保存。
- 渠道发布只替换目标 Set 的平台意图；BYOK 保存只写入或删除当前用户意图，两者不读取 new-api 内存配置。
- 只有统一 reconciler 可以生成完整 JSON 并执行一次 `PUT GroupRatio`；下发过程使用 Set 级 `group_ratio_write` 分布式 lease。
- new-api 的远端读取只用于漂移观测，绝不能作为下一份 `GroupRatio` 的合并输入。
- `llmgateway_group_ratio_apply_states` 保存 desired/applied version、fingerprint 和最后错误；core worker 周期修复 `pending/error` Set。

用户关闭全部 BYOK provider 或迁移 Set 时，在同一意图事务中删除旧行，并将受影响的旧、新 Set 都标记为待协调。高频修改采用 latest-wins，不为每次点击生成不可变 revision。

同一 Set 的新 BYOK group 由 reconciler 批量合并，一次更新 `GroupRatio`。已保存 `RemoteChannelID` 的 provider 直接按 ID 更新，只有首次创建或远端对象丢失时才使用名称搜索。

## 租户观测状态机

新增 `llmgateway_tenant_observation_tasks`，按用户保存 `requested_version`、`processing_version`、状态、优先级、重试时间和 lease。新用户、订阅变化、迁移和人工刷新立即入队；周期修复使用较低优先级。

成功观测后写入 `llmgateway_tenant_observations`，并安排下一次刷新。默认活跃租户一小时、非活跃租户六小时，加入随机抖动。失败指数退避；Set 不存在、disabled 或 unready 时任务进入等待状态，不持续请求失效域名。

后台消费者使用专用轻量查询，不复用管理列表的总数统计、JOIN 和 API key 聚合。上线时按主键 cursor 分批为现有 new-api 租户补齐任务，避免大事务。

## 数据库与停机

所有 worker pool 必须显式配置 LLMGateway MySQL 的最大连接数、空闲连接数和连接生命周期。每个消费者都有全局并发和每 Set 并发上限；不能依赖 CPU HPA 代替后端保护。

BYOK 和观测任务使用 at-least-once 执行，远端写操作必须保持幂等。SIGTERM 后先停止领取，再等待正在执行的任务；无法在宽限期完成时主动释放 lease，不能留下只能等待 TTL 的任务。

## 指标与扩容

`core` 固定两个副本，以 MySQL job lease 保证单例执行。`byok` 和 `observer` 初始各两个副本，后续根据队列指标扩容：

- BYOK：到期任务数、最老等待时间、成功/失败吞吐、过期 lease。
- Observation：到期任务数、最大 stale age、成功/失败吞吐、blocked Set 数。
- 共同指标：活跃消费者、任务耗时、每 Set 并发、MySQL 连接池状态。

指标禁止携带 user ID；`set_id` 可以作为低基数标签。

## 上线顺序

1. 修复 BYOK 过期 lease 恢复与续租。
2. 建立 `GroupRatio` 本地权威投影、Set 级锁和恢复 reconciler。
3. 启动独立 BYOK pool，关闭 core 中的旧 BYOK 定时 job。
4. 创建 observation task 表并分批回填。
5. 启动独立 observer pool，将旧 cursor 观测 job 收敛为只负责按水位播种用户任务。
6. 扩 core 至两个副本，再逐步增加 BYOK/observer 副本并执行云上压测。
