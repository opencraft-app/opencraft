# BYOK GroupRatio 权威投影设计

## 背景

new-api 的 `GET /api/option/` 返回当前进程内的 `OptionMap`。在多 Pod 部署下，不同 Pod 的内存可能在 `SYNC_FREQUENCY` 窗口内不一致。即使 LLMGateway 使用了跨进程 MySQL lease，读取某个 Pod 的旧 `GroupRatio` 再完整写回，仍可能删除其他 Pod 已经写入的新 BYOK group。

因此，new-api 只能作为配置下发目标。LLMGateway 不再使用远端 `GroupRatio` 参与任何合并。

## 核心约束

1. LLMGateway MySQL 是 `GroupRatio` 的唯一真源。
2. 所有业务模块只写本地意图；只有 Set 级 reconciler 可以向 new-api 写 `GroupRatio`。
3. 平台 group 和 `byok_*` group 使用独立命名空间，渠道包禁止声明 `byok_*`。
4. 用户操作按行 O(1) 写入；完整 JSON 按 Set 合并、限频下发。
5. new-api 读取只用于漂移观测，不能作为下一份配置的输入。

## 数据模型

### `llmgateway_group_ratio_desired`

每行表示某个 Set 应存在的一个 group：

- `set_id`、`group_name`：联合主键。
- `ratio`：倍率；BYOK 固定为 `0`。
- `source_type`：`platform` 或 `byok`。
- `source_id`：平台渠道包 ID 或外部用户 ID。
- `external_user_id`：仅 BYOK 使用，允许用户跨 Set 原子移动。
- `created_at`、`updated_at`。

平台渠道包发布时，事务内替换目标 Set 的全部 `platform` 行。用户发起 BYOK 同步时，事务内写入或删除该用户对应的 `byok` 行。

### `llmgateway_group_ratio_apply_states`

每个 Set 一行：

- `desired_version`：每次意图发生有效变化时递增。
- `applied_version`：最近一次成功下发的版本。
- `desired_fingerprint`、`applied_fingerprint`：规范化完整 JSON 的 SHA-256。
- `status`：`pending`、`applying`、`synced`、`error`。
- `last_error`、`last_applied_at`、`created_at`、`updated_at`。

不为每次 BYOK 点击创建不可变 revision。高频用户修改采用 latest-wins；渠道包自身继续保留不可变 revision。

## 写入流程

### BYOK

1. 用户设置先作为草稿保存，不自动下发。
2. 用户发起同步时，在一个 MySQL 事务内：
   - 将启用 provider 标记为 pending；
   - 有启用 provider 时 upsert `byok_<user-hash>` 意图，无启用 provider 时删除该意图；
   - 递增 Set 的 `desired_version`；
   - enqueue/合并该用户的 BYOK sync task。
3. BYOK worker 按 Set 领取任务，先调用统一 reconciler，再并发同步该批用户的 channel、group 和 token。
4. 同一用户连续修改只保留最新任务版本；Set 级完整下发包含数据库中全部有效 group，不依赖本批任务列表。

### 渠道发布

1. 非 `GroupRatio` option 继续按现有渠道发布流程写入。
2. `GroupRatio` option 不直接写 new-api，而是替换目标 Set 的平台意图行并递增版本。
3. 发布流程同步调用统一 reconciler；失败时保留 pending/error 状态，可重复发布。
4. 回滚渠道 revision 等价于产生一份新的平台意图，再由 reconciler 下发。

### Set 迁移

用户迁移时，将旧 Set 的 BYOK 意图删除并写入新 Set；两个 Set 都递增版本并进入待协调状态。迁移操作可重复执行。

## Reconciler

每次协调一个 Set：

1. 获取现有 `group_ratio_write` 分布式 lease。
2. 从本地 Store 读取该 Set 全部 desired 行。
3. 按 group 名排序并生成规范化 JSON 与 fingerprint。
4. 如果 `applied_version`、fingerprint 已匹配，则直接成功。
5. 向 new-api 执行一次 `PUT GroupRatio`，不先执行远端 GET。
6. 成功后提交 applied 状态；失败记录错误并保留 desired 状态。
7. 下发过程中若 `desired_version` 已变化，保持 pending，下一轮继续应用最新版本。

事件触发负责及时生效，worker 周期性扫描 `pending/error` Set 负责崩溃恢复。每个 Set 同时最多一个 GroupRatio 下发。

## 多 Pod 生效语义

new-api PUT 成功只表示数据库已经持久化且处理该请求的 Pod 已更新。其他 Pod 按 `SYNC_FREQUENCY` 刷新，因此 LLMGateway 将状态区分为“已下发”和 new-api 的最终缓存传播窗口。传播期间 BYOK 请求允许走平台 fallback，不把 PUT 200 描述为所有流量 Pod 即时生效。

## 容量边界

单 Set 10,000 个 BYOK group 的完整 JSON 预计为数百 KiB。LLMGateway 真源按行保存，只在协调时于内存生成完整 JSON；上线前必须验证 new-api 生产 `options.value` 的字段类型和请求体限制。本地真实 MySQL 8.4 Set 的 `options.value` 为 `LONGTEXT`；当前单元容量测试生成 10,001 个 group（含 `default`）约 260 KiB，并验证只执行一次 PUT。生产仍需复核目标库 DDL，并测量 new-api 持久化和多 Pod 缓存刷新耗时。

## 上线迁移

1. 幂等扫描已有 `llmgateway_user_llm_settings` 与用户绑定，回填有效 BYOK 意图。
2. 首次协调时从 LLMGateway 本地记录的已应用渠道 revision 恢复平台意图；没有稳定真源或多个真源冲突时 fail-closed，禁止写远端。
3. 标记全部 active Set 为 pending，并由 reconciler 完整下发。
4. 完成后旧的远端读改写路径不再可达。

## 验收标准

- 并发 worker 和渠道发布不会丢失已存在的 BYOK group。
- GroupRatio 下发路径不会调用 new-api `GET /api/option/`。
- 同一用户多次修改最终以最新版本为准。
- 任一进程在意图写入后崩溃，任务和 Set apply state 都可恢复。
- 迁移和删除会同时协调受影响的 Set。
- 10,000 group 的完整快照可在目标资源预算内完成。
