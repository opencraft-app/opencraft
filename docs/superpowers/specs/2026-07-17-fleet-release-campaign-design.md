# new-api 全 Set 连续发布设计

## 目标

为一个 `LLMFleet` 中的全部 new-api Set 提供可恢复的连续发布。发布必须按照
Release Ring 顺序推进，Ring 内严格一次升级一个 Set；任何失败都会停止后续发布。
系统不修改 new-api，也不把多 Set 顺序交给 KRO 或 Kubernetes Deployment rollout。

## 分层职责

### 单 Set 升级

沿用现有数据库感知蓝绿状态机：暂停管理写、升级唯一 admin master、验证旧 traffic
与新 Schema 兼容、创建 Green、执行真实模型探针、通过 Redis CAS 切流、观察并排空
Blue。Schema 只允许 expand-compatible 变更，不自动回滚。

### Release Ring rollout

Ring rollout 负责按不可变快照逐个升级 Ring 内的 Set。全部 Set 完成后不再立即标记
成功，而是进入持久化的 `soaking`：

1. 记录 `soak_started_at` 和 `soak_deadline`；
2. 到期前不允许 Ring 回到 `steady`；
3. 到期后对快照中的每个 Set 执行健康门禁；
4. 全部通过才把 rollout 标记为 `completed`，Ring 更新 `serving_release_id`；
5. 任一门禁失败则 rollout `paused`、Ring `degraded`。

健康门禁使用 LLMGateway 已有的可靠事实：Set 必须 active、当前 Release 正确、无目标
Release 残留、管理写未暂停、admin health 健康、admission 重新检查通过。单 Set 状态机
已经在切流后的回滚窗口持续执行真实模型探针，因此 Ring 门禁不重复创造另一套流量探针。

### Fleet campaign

Campaign 是 Ring rollout 的父编排：

```text
pending -> running -> soaking -> running -> ... -> completed
                    \-> paused
```

创建时根据目标 Release 的 `source + namespace + fleet` 选取全部 Release Ring，按
`ordinal, id` 排序，并为仍有 Set 未到目标版本的 Ring 保存不可变 step 快照。Campaign
一次只允许一个 step 处于运行态：

1. 为当前 step 原子创建 Ring rollout；
2. 等待 rollout 完成，包括其观察期和健康门禁；
3. 标记 step 完成并创建下一个 Ring rollout；
4. 最后一个 step 完成后 Campaign 才完成。

同一 Fleet 同一时间只允许一个非终态 Campaign。创建 Campaign 与第一个 Ring rollout
由 worker 分步执行，但 Ring rollout 与 step 绑定必须在同一 MySQL 事务内落库，避免进程
退出后重复创建发布。

## 数据模型

新增 `llmgateway_release_campaigns`：

- `id`、`source`、`namespace_name`、`fleet`；
- `target_release_id`、`status`；
- `current_ring_id`、`current_rollout_id`；
- `total_rings`、`completed_rings`；
- `last_error`、`created_at`、`updated_at`。

新增 `llmgateway_release_campaign_rings`：

- `campaign_id + sequence` 主键；
- `ring_id`、`status`、`rollout_id`；
- `last_error`、`created_at`、`updated_at`。

扩展 `llmgateway_release_rollouts`：

- `campaign_id`、`campaign_sequence`；
- `soak_started_at`、`soak_deadline`；
- `last_gate_checked_at`、`last_gate_error`。

## 后台推进

新增 core worker job `reconcile_release_campaigns`，使用现有 Worker Job MySQL lease 保证
跨 Pod 单例。每轮先处理到期的 Ring soak，再推进 Campaign：

- rollout 仍运行：只刷新投影；
- rollout 进入 soak：Campaign step 显示 `soaking`；
- rollout 完成：完成 step 并推进下一 Ring；
- rollout 暂停/失败：Campaign 自动暂停并保存原因；
- Campaign 暂停后不会自动恢复。

手动恢复会重新检查当前 rollout。若仍存在失败或 rolled-back 的 Set run，则拒绝恢复；
若是健康门禁失败，则重新开始完整 Ring soak 窗口，防止修复后立即越过观察期。

## 管理 API

```text
GET  /api/admin/release-campaigns
POST /api/admin/release-campaigns
GET  /api/admin/release-campaigns/{id}
POST /api/admin/release-campaigns/{id}/pause
POST /api/admin/release-campaigns/{id}/resume
```

创建请求只需要 `target_release_id`，发布范围由目标 Release 的 Fleet 和当前 Ring 快照决定。
响应包含 Ring steps、当前 Ring、当前 rollout、完成进度和失败原因。

## 管理台

「版本发布」页面以 Fleet Campaign 作为推荐入口，显示目标版本、Ring 进度、当前 Set、
观察期截止时间和暂停原因。保留单 Ring rollout 作为故障处理入口，但降低视觉优先级。

## 验收

1. 三个 Ring 按 ordinal 依次发布，后一个 Ring 不会提前创建 rollout。
2. Ring 全部 Set 完成后进入真实 soak，到期前不会完成。
3. 健康门禁失败会暂停 rollout、Ring 和 Campaign，后续 Ring 不启动。
4. 显式恢复会重新开始观察期，并能在修复后继续原 Campaign。
5. worker 在任意状态重启后从 MySQL 继续，不重复创建 rollout 或升级 Set。
6. 同一 Fleet 并发创建 Campaign 只有一个成功。
7. 集群 E2E 在持续普通请求和 SSE 下完成 Canary -> Early -> Stable 的真实 A/B 发布。
