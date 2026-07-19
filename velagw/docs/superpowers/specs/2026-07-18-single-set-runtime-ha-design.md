# 单 Set Runtime 高可用定义

## 目标

单 Set 的计划升级与意外故障使用不同的连续性契约：

- 计划升级或 `SIGTERM`：已有 3 分钟 SSE 不得中断，新请求不得失败。
- traffic Pod 突然消失：已有 SSE 允许中断一次；新请求不能连续失败，客户端重新建立 SSE 后必须立即恢复。
- 单个计算可用区不可用：Set 仍有一个 traffic 副本可以接收新请求。

这里不承诺把已经建立的 TCP/SSE 连接迁移到另一个 Pod。意外死亡没有排空机会，客户端必须具备重连能力。

## 生产拓扑

- `LLMFleet.spec.availability.traffic` 是唯一声明源，显式保存副本水位、拓扑键和 PDB 最小可用数。
- 每个 Set 的目标 traffic 副本数固定为 2。
- versioned traffic Deployment 使用 `topology.kubernetes.io/zone` 的强制拓扑分散，两个副本不能落在同一可用区。
- 每个 runtime generation 生成独立的 `PodDisruptionBudget`，`minAvailable=1`。
- admin master 仍是单副本 `Recreate`；它不承载 `/v1/*`，不参与 traffic 高可用计算。
- LLMGateway traffic 必须启用 `LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED=true`，runtime route 缺失时禁止回退到 Key 快照中的历史地址。

## 控制闭环

- KRO 将每个 versioned traffic Deployment 与 PDB 的观测状态聚合到 `LLMFleet.status`。
- set-manager 只读取和修正 `LLMFleet` CR，不扩展对子 Deployment、Pod 或 PDB 的 RBAC。
- set-manager 将每个 Set 的期望副本、Ready 副本和 PDB 状态作为 reconcile fact 写入控制面 MySQL。
- 声明过 HA 策略的 Set 只有在状态为 `healthy` 时才能接收新租户；`pending` 或 `degraded` 不影响剩余副本继续承载存量流量，但必须停止新准入。
- 运营总览展示副本水位和失败原因，并为 `degraded` 生成紧急告警。

## MySQL 连接预算

每个 Set 的逻辑连接上限按以下公式计算：

```text
admin_max_open + traffic_replicas * traffic_max_open
```

生产默认值为：

```text
admin_max_open = 16
traffic_max_open = 8
traffic_replicas = 2
max_sets_per_shard = 24
```

因此单个 Shard 的 Set 连接预算为 `24 * (16 + 2 * 8) = 768`。以 MySQL `max_connections=1000` 计算，保留 232 个连接给 LLMGateway worker、故障重连、运维和短时重叠。订阅写并发保持 8，满足 admin 连接池至少为其两倍的现有约束。

## 回归门禁

新增独立破坏性场景 `set_traffic_pod_failure_gate`：

1. 目标 Set 必须恰好一个，且至少有两个 Ready traffic Pod。
2. 两个 Pod 必须位于不同 `topology.kubernetes.io/zone`。
3. 持续发送普通聊天请求，并直连待删除 Pod 建立一条长 SSE。
4. 对一个 active traffic Pod 执行零宽限删除，等待不同 UID 的替代 Pod Ready。
5. 普通请求允许孤立失败，但禁止连续失败；恢复窗口内必须达到最小成功样本数。
6. 原 SSE 可以完整结束或中断；中断的流必须重新建立并完整完成。
7. 替代 Pod 仍须满足双副本、跨区和 PDB 健康（`expectedPods=2`、`currentHealthy=2`、`disruptionsAllowed>=1`）。

该场景只验证计算层意外故障。Shard MySQL/Redis 和中央 route Redis 的故障由独立门禁覆盖。
