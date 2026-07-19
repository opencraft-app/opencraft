# 中央控制面停机日常门禁设计

## 目标

新增 `control_plane_outage_gate`，在 Kubernetes 集群内制造 90 秒中央控制面整体不可用，证明已经签发的模型 Key 不依赖 control、worker 或 Set Manager 才能持续完成推理，并证明控制面恢复后积压任务只执行一次且最终收敛。

北京环境是允许执行破坏性回归的测试环境。该门禁仍必须限制操作对象、保存原始状态并提供独立于主运行上下文的安全恢复，不能依赖人工善后。

## 故障边界

门禁操作以下资源：

- `llmgateway-control` Deployment 缩容到 0。
- 所有显式配置的 `llmgateway-worker-*` Deployment 缩容到 0。
- `llmgateway-set-manager` CronJob 暂停，并等待已经启动的 manager Job 结束。

以下资源必须保持运行：

- `llmgateway-traffic`。
- Redis、MySQL。
- 所有 new-api Set 的 admin-master 和 traffic runtime。
- 回归 pacer 与 mock OpenAI-compatible 上游。

门禁不使用 NetworkPolicy，也不持续删除 Pod。Deployment 副本数归零能提供确定、可观测且可逆的进程级停机语义。

## 执行流程

### 建立基线

复用现有控制面回归原语：

1. 验证 control、traffic、mock、pacer 和目标 Set 已就绪。
2. 将回归渠道同步到目标 Set。
3. 创建回归租户、订阅和外部 Key。
4. 使用该 Key 完成非流式与流式请求。

### 进入停机窗口

1. 读取并保存 control、每个 worker Deployment 的原始副本数和 Set Manager CronJob 的原始 suspend 状态。
2. 暂停 Set Manager CronJob；如果 CronJob 仍有关联的 active Job，等待它结束，超时则失败，不删除非本次回归创建的 Job。
3. 将全部 worker Deployment 缩容到 0，并等待 `readyReplicas=0`。
4. control 仍存活时调用 `POST /api/admin/jobs/refresh_set_capacity/run`，把任务的 `next_run_at` 推到当前时间；记录排队前的任务状态和运行记录水位。
5. 将 control Deployment 缩容到 0，并等待 `readyReplicas=0`。
6. 从 control 不可访问开始计算 90 秒停机窗口。

### 流量断言

停机窗口内每秒通过 `llmgateway-traffic` 发起一次聊天请求：

- 至少收集 60 个成功样本。
- 所有请求均为 2xx。
- 所有响应均包含固定回归 marker。
- 不允许 401、5xx、路由到错误 Set 或无法解析外部 Key。
- 单次请求失败立即记录，但采样持续到窗口结束，以得到完整失败分布；最终任何失败都会使门禁失败。

流量客户端不得调用 control，也不得重新签发 Key。测试验证的是停机前已经存在的 Key 和路由状态。

### 恢复与追平

1. 恢复 control 原始副本数并等待全部副本 Ready。
2. 恢复所有 worker 原始副本数并等待全部副本 Ready。多个 worker 副本同时恢复，用于验证 MySQL lease 排他性。
3. 轮询 `refresh_set_capacity`：
   - `last_success_at` 必须晚于排队时间。
   - `next_run_at` 必须回到未来。
   - `lease_owner` 必须清空，lease 不得残留。
4. 查询排队时间之后的任务运行记录：
   - 必须恰好出现一个成功 run。
   - 不允许出现第二个 success/error run。
   - run owner 必须非空。
5. 恢复 Set Manager CronJob 的原始 suspend 状态。
6. 再执行一次聊天请求，确认恢复控制面没有扰动 traffic。

## 任务运行记录 API

新增只读接口：

```text
GET /api/admin/jobs/{name}/runs?after=<RFC3339>&limit=<n>
```

约束：

- 复用 admin 鉴权。
- `name` 必须对应已存在的 worker job。
- `after` 可选；提供时只返回 `started_at >= after` 的记录。
- `limit` 默认 20、最大 200。
- 按 `started_at,id` 倒序返回。
- API 只暴露已有任务运行事实，不允许修改、删除或重放 run。

Store 的 `WorkerJobRunListOptions` 增加时间水位字段。MemoryStore 与 MySQLStore 必须保持一致语义。

## Kubernetes 权限与安全清理

回归 Kubernetes 客户端新增读取和更新 Deployment 副本数、等待副本状态的能力。RBAC 只允许操作以下明确资源名：

- `llmgateway-control`
- `llmgateway-worker-admin`
- `llmgateway-worker-byok`
- `llmgateway-worker-core`
- `llmgateway-worker-maintenance`
- `llmgateway-worker-observer`

禁止通配修改任意 Deployment，禁止修改 `llmgateway-traffic` 和 new-api runtime。

读取到原始状态后立即注册 safety cleanup。恢复动作使用 `context.WithoutCancel` 派生的独立超时上下文，按 control、workers、CronJob 的顺序恢复。恢复操作必须幂等；测试成功、失败、panic、SIGTERM 或主上下文取消都执行同一套恢复。

如果某个 Deployment 原始副本数就是 0，保持为 0；门禁不得假设固定副本数。若 control 或 worker 列表为空、目标资源缺失、traffic 与目标 Set 未就绪，门禁在制造故障前失败。

## 配置

日常门禁默认值：

```yaml
controlPlaneOutage:
  controlDeployment: llmgateway-control
  workerDeployments:
    - llmgateway-worker-admin
    - llmgateway-worker-byok
    - llmgateway-worker-core
    - llmgateway-worker-maintenance
    - llmgateway-worker-observer
  managerCronJob: llmgateway-set-manager
  backlogJob: refresh_set_capacity
  outageDuration: 90s
  trafficInterval: 1s
  minimumSamples: 60
  recoveryTimeout: 5m
```

配置校验要求 outage duration、采样间隔、最小样本数和恢复超时为正数，且理论采样数不少于 minimum samples。Deployment 名称必须唯一；control、traffic 和 worker 名称不得重叠。

## 测试

### 单元测试

- API 的 job name、after、limit 校验和排序。
- MemoryStore/MySQLStore 的 `after` 水位查询语义。
- 配置默认值、重复 Deployment、样本数不足等校验。
- 缩容顺序为 manager suspend、workers zero、queue backlog、control zero。
- 恢复顺序和原副本数保持。
- 90 秒采样中任意失败使场景失败。
- 恢复后零个、多个、失败 run 均不能通过。
- canceled context 下 safety cleanup 仍恢复所有资源。

### 北京真实 TKE 门禁

- 使用一个隔离目标 Set 和不可变 runner 镜像。
- 真实缩停 control、五类 worker 并暂停 Set Manager。
- 90 秒内至少 60 个流量样本且零失败。
- 恢复后 `refresh_set_capacity` 恰好一个成功 run，lease 清空。
- control、worker、CronJob 恢复原状，受控测试资源清理完成。
