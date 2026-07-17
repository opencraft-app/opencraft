# Admin 与数据库感知的 Set 升级设计

## 目标

在不修改 new-api 的前提下，让每个 Set 同时具备推理流量无损升级和数据库迁移可控升级。traffic slave 使用版本化蓝绿运行时；唯一 admin master 受控原地升级并承担数据库迁移；LLMGateway 在 admin 窗口持久化管理命令。

## 拓扑约束

- 每个 Set 恰好一个 `NODE_TYPE=master` 的 admin Pod。
- admin Service 不接收 `/v1/*` 推理流量，只允许 LLMGateway control/worker 和受控控制台访问。
- traffic runtime 全部使用 `NODE_TYPE=slave`，不得执行数据库迁移和 master-only 后台任务。
- 同一 Set 的 admin 与 traffic 共享该 Set 独立的 MySQL 数据库和 Redis DB。

## 升级状态机

标准顺序为：

```text
pending -> upgrading_master
        -> verifying_compatibility -> preparing -> probing -> switching
        -> draining -> completed
```

1. 领取升级 run 的同一事务暂停目标 Set 的新用户准入和直接管理写；新命令持久化为 pending。
2. `upgrading_master` 使用 Recreate 更新唯一 admin master，由它执行真实数据库迁移。
3. `verifying_compatibility` 使用旧 traffic 执行受控推理，验证其可继续使用迁移后的 Schema。
4. `preparing` 至 `draining` 复用现有 traffic 蓝绿、Redis revision CAS 和 Transport 代际隔离。
6. Green 切流成功后解除管理写暂停；Blue 只保留既有请求并在排空期限后删除。

升级 run 使用 Set 级 lease。所有动作必须可在 control、worker 或 set-manager 重启后从持久状态继续。

## 数据库迁移门禁

自动升级只接受在发布前回归环境确认过的 expand-compatible 变更。生产控制环不创建临时数据库，也不向 set-manager 授予 MySQL 管理权限。删除旧列、修改旧列类型、nullable 到 not-null 收紧，以及依赖历史数据和锁时间预算的迁移必须拆成独立迁移流程。

发布批准记录：

- 目标镜像 digest；
- 回归环境迁移是否成功；
- 是否兼容当前 traffic 镜像；
- Job 成败与可供排障的失败摘要。

数据库迁移不自动回滚。应用回滚依赖扩展后的 Schema 继续兼容旧镜像。破坏性清理必须放在后续独立 contract 发布中。

## 管理写恢复

LLMGateway 保存订阅发放、取消、续期和密钥签发命令的业务幂等键、Set、命令类型、载荷、状态、尝试次数、下次执行时间和结果。Set 正在升级时，API 返回 `202 Accepted` 和命令 ID。

- GET 和只读检查可以有限重试。
- 覆盖式、确定性更新可以使用指数退避重试。
- 创建订阅、增减额度、创建 Token/Channel 等非幂等操作不能盲目重试；未知结果必须通过业务查询确认。
- 同一业务幂等键只允许一个有效命令；worker 使用 lease claim，允许多实例有界并发。

## 失败语义

- admin 升级失败：旧 traffic 继续服务，管理命令保持 pending，Set 标记 admin unhealthy。
- 兼容探针失败：不创建或不切换 Green，停止当前批次。
- Green 切流前失败：删除 Green，Blue 不受影响。
- Green 切流后失败：在回滚窗口内用更大的 `route_revision` 切回 Blue。
- 任一 Set 失败只停止当前批次，不改变其他 Set。

## 验证范围

- 单元测试覆盖状态机、lease、幂等命令、未知结果恢复、Schema 分类和失败恢复。
- HTTP 测试覆盖升级创建/查询、排队返回、命令状态和非法迁移拒绝。
- OrbStack E2E 覆盖 admin 窗口写入排队、旧 traffic 不断流、SSE、Green 切流、失败回滚和进程重启恢复。
- 生产 Canary 使用 MockLLM，先一个低水位 Set，再逐批推进。
