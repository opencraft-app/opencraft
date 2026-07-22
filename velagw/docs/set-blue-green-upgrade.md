# Set 数据库感知升级操作手册

## 目标与边界

不修改 new-api。每个 Set 只有一个 `NODE_TYPE=master` 的 admin Pod；它使用
`Recreate` 更新并负责数据库迁移，但不承载 `/v1/*` 推理流量。所有推理 Pod 都是
`NODE_TYPE=slave`，通过独立版本代际执行蓝绿切换。

LLMGateway traffic 始终只读 Redis：先由外部 key 找到 Set，再读取
`llmgateway:set-runtime:{set_id}` 获取当前 traffic Service。切换时 `route_revision`
单调递增，连接池以 `(set_id, route_revision)` 隔离，因此切换和回滚都不会复用旧
keepalive 连接。

数据库迁移不自动回滚。自动化只允许 expand-compatible 变更，旧 traffic 必须在
迁移后的 Schema 上通过真实推理探针，才会创建和切换 Green。

## 状态机

```text
pending -> upgrading_master -> verifying_compatibility
        -> preparing -> probing -> switching -> draining -> completed
```

- `upgrading_master`：暂停该 Set 的新用户准入和直接管理写，使用 `Recreate` 更新唯一
  admin master。推理流量仍由 Blue slave 承载。
- `verifying_compatibility`：旧 traffic 使用迁移后的生产 Schema 连续通过三次受控推理。
- `preparing/probing`：创建目标镜像 Green slave，等待就绪并连续通过三次受控推理。
- `switching`：control 在 MySQL 事务内更新 active generation、递增 route revision 并写
  outbox；Redis CAS 成功后恢复管理写并进入排空。
- `draining`：新请求只进入 Green。Blue 在生产保留 330 秒，本地保留 15 秒；超时后
  允许中断仍未结束的 SSE。

生产控制环不创建临时数据库，也不向 set-manager 授予 MySQL 管理权限。数据库兼容性必须在
发布前回归环境验证；生产只接受固定 digest 的已批准镜像。依赖历史脏数据、超大表回填、
长时间 metadata lock 或破坏性 contract 变更的版本不得进入自动升级，必须拆成独立迁移流程。

## 管理写恢复

admin 暂停期间，下列操作写入 `llmgateway_admin_commands`，API 返回 `202 Accepted` 和
`Location: /api/internal/admin-commands/{command_id}`：

- 开通或续购订阅；
- 取消订阅；
- 对齐订阅结束时间；
- 签发用户访问密钥。

admin worker 独立部署并使用 MySQL lease；同一业务 `dedupe_key` 只能有一条命令。订阅
发放沿用业务幂等键，没有传入时 LLMGateway 为排队命令生成内部幂等键。未知写入结果标记
为 `unknown`，不会盲目重试。渠道发布、BYOK 和租户观测已有各自的持久化任务，不重复套队列。

## 创建升级

多 Set 生产发布应通过 Release Ring Rollout 创建本接口的 batch，详见 [new-api 多 Set 版本发布](release-rings.md)。本接口仍保留为单 Set 执行和故障处理入口。

目标镜像必须固定到不可变 digest：

```http
POST /api/admin/set-upgrades
Authorization: Bearer <cluster-admin-token>
Content-Type: application/json

{
  "set_ids": ["set-a"],
  "target_image": "registry.example.com/new-api@sha256:<64-hex>",
  "max_parallel": 1,
  "stop_on_failure": true,
  "drain_timeout_seconds": 330,
  "rollback_window_seconds": 300
}
```

生产先选一个低水位 Canary Set，稳定前保持 `max_parallel=1`，后续最多同时升级 Set
总数的 10%。同一 Set 只允许一个非终态 run，批次并行度由 MySQL claim 事务强制执行。

## 回滚与重试

只有 Blue 尚未删除且 run 仍处于 `draining` 时允许回滚：

```http
POST /api/admin/set-upgrade-runs/{run_id}/rollback
Authorization: Bearer <cluster-admin-token>

{"reason":"canary error rate increased"}
```

回滚恢复旧 runtime generation，但生成更大的 `route_revision`。它只回滚 traffic 应用，
不会回滚 admin 镜像或数据库 Schema；因此 expand compatibility 是硬门禁。Green 在回滚窗口
内连续三次探针失败时自动回滚并停止当前批次。明确可重试的 `failed` run 可调用 `/retry`。

## 发布前检查

1. `llmgateway-worker-admin` 至少两个副本，MySQL command lease 正常。
2. maintenance worker 已运行，并配置 route cache Redis。
3. 所有 active Set 已有 runtime 记录，生产开启 `LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED=true`。
4. admin Deployment 为单副本 `Recreate`，traffic Service selector 只有
   `llmgateway.io/newapi-role=traffic`。
5. LLMFleet 中 `adminImage`、`legacyTrafficImage` 和目标 runtime image 均固定到 digest。
6. set-manager RBAC 只允许读取和 patch `LLMFleet`，不允许创建迁移 Job 或访问数据库 Secret。

## 故障处理

- admin 升级失败：Blue traffic 继续服务；管理命令保持 pending；修复后重试，不回滚 Schema。
- 旧 traffic 兼容探针失败：不创建 Green，停止批次并保留管理写暂停，等待人工处理。
- Green 切流前失败：删除 Green，恢复管理写；Blue 不受影响。
- Redis 发布失败：run 停在 `switching`；outbox 重试，CAS 禁止旧 revision 覆盖新路由。
- set-manager 重启：lease 过期后按持久状态继续，不重复递增 revision。
- 命令状态 `unknown`：根据业务键查询 new-api 最终状态后人工确认，禁止直接重放。

## 本地回归

```bash
k8s/orbstack-kro/e2e/run-fresh.sh
k8s/orbstack-kro/e2e/run-upgrade.sh
```

回归使用 MockLLM，必须覆盖 admin Recreate、升级窗口管理写排队、旧 traffic
兼容探针、Green 探针、Redis 切流、15 秒排空、普通请求与 20 秒 SSE，以及失败回滚。
