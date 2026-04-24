---
title: 'CTL 实例 Churn Guard 与 Pool Pressure 可观测性'
slug: 'ctl-instance-churn-guard'
created: '2026-03-27'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4, 5]
tech_stack:
  - Go 1.24+
  - Redis (go-redis/v9)
  - Prometheus
  - Grafana
  - sandbox internal API
  - zap
  - TOML (BurntSushi)
files_to_modify:
  - ctl/pkg/instance/churn_guard.go (new)
  - ctl/pkg/instance/logic.go
  - ctl/pkg/instance/async.go
  - ctl/pkg/bypass/check_pool_pressure.go (new)
  - ctl/pkg/adapter/sandbox/adapter.go
  - ctl/pkg/adapter/sandbox/types.go
  - ctl/pkg/metric/instance.go
  - ctl/pkg/config/define.go
  - ctl/pkg/config/config.go
  - ctl/pkg/errcode/instance.go
  - ctl/main/api/server.go
  - ctl/main/api/server_test.go
  - ctl/main/api/main.go
  - ctl/main/service/main.go
  - ctl/main/bypass/main.go
  - ctl/conf/server/common/server_conf.toml
  - ctl/conf/local/common/server_conf.toml
  - ctl/conf/local/rewrite/server_conf_rewrite.toml
  - ctl/deploy/grafana/dashboards/openclaw-overview.json
  - infra/test/beijing/sandbox/observability/grafana/ctl-overview.json
  - infra/test/beijing/sandbox/observability/grafana/README.md
  - docs/agent-guides/ctl-observability-guide.md
  - docs/deploy-guides/ctl-deploy-guide.md
code_patterns:
  - 'Create path: API 同步入口做前置判断，真正创建仍走 async task'
  - 'Redis ZSET rolling window: score=event timestamp, member=unique event id'
  - 'Bypass 只做只读采样，不承载业务状态机变更'
  - 'Guard fail-open: Redis/snapshot 异常时放行，避免观测故障扩大成可用性事故'
  - 'Grafana 双文件维护: 子项目本地模板 + infra 托管适配版'
test_patterns:
  - '单元测试: churn guard allow/reject/hot-state 判定'
  - 'HTTP 层测试: 429 + Retry-After header/body'
  - 'adapter 测试: internal pools / pool instances 读取'
---

# Tech-Spec: CTL 实例 Churn Guard 与 Pool Pressure 可观测性

**Created:** 2026-03-27

## Overview

### Problem Statement

`ctl` 创建实例时会调用 `sandbox` 创建 runtime，而 `sandbox` 内部维护的是预创建好的 CVM 资源池。用户如果频繁执行 `create -> destroy -> create -> destroy`，虽然单次语义合法，但会持续把候选 pool 的 `CLEAN` 库存打空，推动更多 `DRY / RESETTING / CREATING` 实例堆积，最终把平台成本和抖动都放大。

之前系统已经有很多“压力水位”类判断，但缺少一个统一的创建保护方案，也缺少能支撑后续调参数的可观测性面板。结果就是：

1. 平台知道自己“有点热”，但不知道热是被谁打出来的。
2. API 层不知道什么时候该拒绝高频 churn 用户。
3. 运维侧看不到候选池库存结构和保护命中率，调参像闭眼拉扳机。

### Final Solution

本次实现选择了一条偏保守、容易上线的路径：

1. **不改变 destroy 语义**：实例销毁仍然是严格销毁，不做 warm reuse。
2. **不排队，直接拒绝**：命中保护条件时，`POST /v1/instances` 直接返回 `429 INSTANCE_CHURN_LIMITED`。
3. **混合触发**：只有“用户 churn 超阈值”且“全局候选池压力为 HOT”时才拒绝。
4. **只读采样 + fail-open**：池压力快照由 bypass 周期刷新到 Redis；若快照缺失或 Redis 出故障，guard 放行而不是误伤正常创建。
5. **观测先补齐**：新增 metrics，并把 `Churn Guard / Pool Pressure` 分区并入现有 `ctl-overview`，便于值班和调参。

### Scope

**In Scope:**

- `ctl` 创建前的 churn guard 判断
- Redis rolling window 计数
- `sandbox` pool 只读采样与 Redis 快照
- `429 + Retry-After` 返回格式
- Prometheus 指标与 Grafana 面板
- 配置项、运行文档、监控文档沉淀

**Out of Scope:**

- 实例复用 / warm pool 回租
- 用户侧新的 queue / reservation API
- `pause / resume` 语义调整
- 基于日志系统的 per-user 长期画像

## Key Design Decisions

### 1. 为什么不是“destroy 后先缓存实例”

这条路理论上更省资源，但会立刻引入新的生命周期语义：

- destroy 到底是“用户看不见但后台保留”，还是“真实销毁”
- quota 何时释放
- 后台保活多久
- sandbox / ctl / ai-gateway 谁负责回收副作用资源

这次先避开这团火，保留当前 destroy 语义，只处理“高频 churn 时要不要继续放量创建”。

### 2. 为什么不是只看全局压力

只看全局压力会把偶发正常创建和恶意/误操作 churn 混在一起。用户 A 疯狂 churn，不应该直接把用户 B 的正常请求也等价对待。

所以采用混合触发：

- 用户最近 `window` 内 `create_success >= threshold`
- 且用户最近 `window` 内 `destroy_accepted >= threshold`
- 且候选池全局压力 `HOT`

这样既能挡住明显 churn，又不会在系统平稳时乱拒绝。

### 3. 为什么要 fail-open

这套 guard 依赖 Redis 计数和 bypass 快照。若这些辅助组件异常，最糟糕的事情不是“少挡了一些 churn”，而是“观测故障变成大面积误拒绝”。

因此实现上明确选择：

- Redis 计数读失败：放行
- 快照不存在：放行
- 快照过期：放行
- bypass 未刷新：放行

同时记录日志和 `fail_open` 指标，后续从观测面发现问题。

### 4. 为什么 pool pressure 由 bypass 刷新

创建请求是高频路径，不适合每次都同步去 `sandbox` 扫 pool 和实例列表。否则保护逻辑本身就会反过来增加依赖链路压力。

所以采用：

- bypass 每 `pressure_snapshot_refresh_seconds` 周期刷新一次
- API create 路径只读 Redis 快照
- TTL 超时则认定快照不可用并 fail-open

## Architecture

### Request Path

`POST /v1/instances` 的执行顺序调整为：

1. 校验参数与用户身份
2. 保证用户默认 quota 存在
3. 先分配 1 份实例 quota
4. 执行 `CreateChurnGuard`
5. 若被拒绝，回滚 quota，返回 `429`
6. 若放行，继续写 `instances` 记录并入队异步创建任务

这里保留了“先 alloc quota 再创建记录”的原顺序，避免因为 guard 引入另一套分叉创建语义。

### User Churn Counter

用户计数用 Redis ZSET 维护两个事件流：

- `create_success`
- `destroy_accepted`

写入规则：

- `create_success`：实例异步任务成功把状态推进到 `Running` 后记录
- `destroy_accepted`：`DestroyInstance` 成功把实例转成 `Deleting` 后记录

这样能避免：

- 创建失败也被算作 churn
- 销毁还没真正受理就被提前计数

### Pool Pressure Snapshot

新增 bypass `checkPoolPressure`，周期性调用 `sandbox` 内部只读接口：

- `GET /internal/pools`
- `GET /internal/pools/{poolID}/instances`

采样后只保留 `ctl` 当前候选模板对应的 pool：

- `default_template_id`
- `candidate_template_ids`

注意这里虽然字段名叫 `template_id`，但在当前集成里它本质上就是 `sandbox` pool ID。

快照内容包含：

- refresh 时间
- pressure state: `hot|cold`
- candidate pool 列表
- 每个 pool 的 `desired / clean / creating / dry / resetting`

### HOT 判定

当前实现采用两个条件，命中任一即视为 `HOT`：

1. `clean_total < max(pressure_min_clean_floor, ceil(desired_total * pressure_clean_ratio_threshold))`
2. `creating + dry + resetting > clean_total`

直觉上就是：

- 干净库存低于合理下限，说明 buffer 不够了
- 正在补货和待清理的量比 clean 还多，说明系统已经开始追着屁股救火

## Configuration

新增配置位于 `[api.instance]`：

```toml
churn_guard_enabled = true
churn_window_seconds = 600
churn_create_threshold = 3
churn_destroy_threshold = 2
pressure_snapshot_refresh_seconds = 5
pressure_snapshot_ttl_seconds = 15
pressure_clean_ratio_threshold = 0.25
pressure_min_clean_floor = 2
```

默认值策略：

- guard 默认开启
- window 默认 10 分钟
- create 阈值 3
- destroy 阈值 2
- snapshot 刷新 5 秒
- snapshot TTL 15 秒

这是一个偏保守的起步配置，后续主要靠 dashboard 来观察是否过严。

## Implementation Details

### 1. Guard 核心

核心逻辑落在 `ctl/pkg/instance/churn_guard.go`：

- `createChurnGuard`
- `redisUserChurnCounter`
- `redisPoolPressureSnapshotStore`
- `poolPressureRefresher`
- `instanceChurnLimitedError`

`instanceChurnLimitedError` 额外暴露 `RetryAfterSeconds()`，供 API 层统一写入：

- HTTP Header: `Retry-After`
- JSON Body: `retry_after_seconds`

### 2. Create / Destroy 生命周期埋点

业务接线点：

- `ctl/pkg/instance/logic.go`
  - `CreateInstance()` 中执行 guard
  - `DestroyInstance()` 成功转 `Deleting` 后记录 destroy 事件
- `ctl/pkg/instance/async.go`
  - `RunCreateInstanceTask()` 成功转 `Running` 后记录 create success 事件
  - 创建失败场景记录 `fail` 指标

### 3. Sandbox Adapter 扩展

`ctl/pkg/adapter/sandbox/adapter.go` 新增只读接口封装：

- `ListPools`
- `ListPoolInstances`

供 bypass 周期任务读取 pool 状态，不影响原有创建/删除主流程。

### 4. API 错误返回

`ctl/main/api/server.go` 为错误响应增加：

- `retry_after_seconds`
- `Retry-After` header

因此用户可以明确知道是“暂时被保护挡住了”，而不是普通 500 或模糊限流。

### 5. Bypass 集成

新增 `ctl/pkg/bypass/check_pool_pressure.go`：

- 名称：`checkPoolPressure`
- 默认每 5 秒刷新
- 输出 Redis 快照
- 顺便把 pool pressure metrics 刷新出来

这是一个只读 bypass，不修改业务状态机。

## Metrics and Dashboard

### New Metrics

新增的主要指标：

- `openclaw_instance_create_rejections_total{reason}`
- `openclaw_instance_churn_guard_eval_total{result}`
- `openclaw_instance_churn_guard_retry_after_seconds`
- `openclaw_instance_user_churn_events_total{event_type}`
- `openclaw_instance_pool_pressure_state{state}`
- `openclaw_instance_pool_pressure_clean{pool_id}`
- `openclaw_instance_pool_pressure_creating{pool_id}`
- `openclaw_instance_pool_pressure_dry{pool_id}`
- `openclaw_instance_pool_pressure_resetting{pool_id}`
- `openclaw_instance_pool_pressure_desired{pool_id}`
- `openclaw_instance_pool_pressure_hot_transitions_total`

注册分布：

- API：guard 决策、rejection、Retry-After
- Service：create success / destroy accepted 对应的用户 churn 事件
- Bypass：pool pressure 状态与转热次数

### Logging

命中拒绝时会带上关键信息：

- `user_id`
- `create_success_count`
- `destroy_accepted_count`
- `pressure_state`
- `candidate_pools`
- `retry_after_seconds`

这样看到一条日志就能知道这次被挡是不是合理。

### Dashboard Panels

已把新面板并入现有 `ctl-overview`，而不是新建一个独立盘。新增分区名：

`Churn Guard / Pool Pressure`

当前包含的核心面板：

1. 当前保护状态
2. 最近 15 分钟被拒绝创建数
3. 创建保护命中率
4. 候选池总 CLEAN 库存
5. 候选池总 DRY+RESETTING+CREATING
6. 候选池总 desired_capacity
7. 创建允许/拒绝趋势
8. 池压力 HOT 状态趋势
9. 候选池库存结构趋势
10. 按 pool 的 CLEAN vs desired
11. 按 pool 的 DRY / RESETTING
12. 最近 15 分钟拒绝原因分布

本地模板和托管适配版都已同步更新。

## Testing and Verification

本次实际验证过：

```bash
go test ./ctl/pkg/instance ./ctl/main/api ./ctl/pkg/bypass ./ctl/pkg/adapter/sandbox
```

覆盖重点包括：

- below-threshold 时允许创建
- user hot + global hot 时拒绝
- pool pressure `HOT` 判定逻辑
- `429` 响应带 `Retry-After`
- sandbox adapter 能读取 internal pool 接口

另外还做了两份 dashboard JSON 的语法校验，确认都是合法 JSON。

## Operational Guidance

### 调参时先看什么

先看这三个信号，不要一上来就改阈值：

1. `openclaw_instance_churn_guard_eval_total{result="reject"}` 是否持续升高
2. `openclaw_instance_pool_pressure_clean` 是否长期贴地
3. `openclaw_instance_pool_pressure_hot_transitions_total` 是否频繁跳变

### 如果 reject 很多，但 pool 不热

说明判断条件可能没同时满足，或者快照常年 fail-open。优先查：

- bypass 是否在跑
- Redis 快照 TTL 是否过短
- `checkPoolPressure` 日志里是否持续报错

### 如果 pool 很热，但 reject 很少

说明多数请求不是高频 churn 用户，或者阈值偏宽。再考虑是否要：

- 下调 `churn_create_threshold`
- 下调 `churn_destroy_threshold`
- 上调 `pressure_clean_ratio_threshold`

不要直接瞎改 `pressure_min_clean_floor`，否则不同规模的 pool 会一起被一刀切。

## Known Limitations

1. 当前按用户维度只保留计数，不在 Prometheus 打 `user_id` 标签，避免高基数。
2. dashboard 里没有 top-N 用户表；如果后续真需要，应优先走日志/离线分析，不要直接把用户标签扔进时序库。
3. snapshot 依赖 bypass；若 bypass 长时间停摆，guard 会退化成 fail-open。
4. 若最近一次快照是 `HOT`，而 sandbox 随后短暂故障，guard 最长会在 `pressure_snapshot_ttl_seconds + 2s` 的窗口内继续沿用旧 `HOT` snapshot 拒绝创建；这是为了避免刷新边界抖动而接受的设计容忍范围。
5. 当前策略仍是“拒绝”，不是“平滑降级”；用户体验上会比排队更硬。

## Future Iterations

如果后续平台仍然被高频 churn 压得冒烟，可以沿这几条路继续：

1. 引入用户维度冷却期，而不只是 rolling window 计数
2. 对超限请求返回更明确的机器可读 reason code
3. 增加基于日志/离线分析的 top churn user 报表
4. 评估 destroy 后短时 warm reuse 的收益与复杂度
5. 若 pool 压力判断长期稳定，再考虑把 guard 从 fail-open 升级成更强约束

## Senior Developer Review (AI)

**Review Date:** 2026-03-27
**Review Outcome:** Changes Requested
**Reviewed By:** Code Review Workflow (AI)

### Summary

2 bad_spec, 10 patch, 3 defer findings. 8 rejected as noise.

### Action Items

- [x] [High] RetryAfter 取 min vs max — 审查误判。拒绝条件是 createCount≥threshold AND destroyCount≥threshold AND HOT，取 min 正确：任一计数先跌破阈值即解除拒绝。不改逻辑，已补代码注释说明语义。
- [x] [High] Snapshot Refresher 单个 pool 失败导致整体刷新失败 — 已修复：单个候选 pool 拉取失败时改为 `warn + skip`，其余 pool 仍可产出 snapshot。
- [x] [High] destroy_accepted 在已 Deleting 状态时重复记录 — 已修复：仅在实例首次转入 `Deleting` 时记录 destroy accepted 事件。
- [x] [Med] Bypass 错误期间 stale HOT snapshot 持续误拒 — 不改逻辑，已在 Known Limitations 补充说明：sandbox 故障后最长 pressure_snapshot_ttl_seconds + 2s 窗口内 guard 仍可能基于旧 HOT snapshot 拒绝。
- [x] [Med] 配置边界值缺少校验 — 已修复：`PressureRefreshSec <= 0`、`PressureTTLSec <= 0` 和 `PressureCleanRatio <= 0 || > 1` 会回落到安全默认值。
- [x] [Med] 所有候选池 desiredCapacity=0 时误判 HOT — 接受当前行为，主动缩容到 0 是极端运维操作且仍需用户同时超 churn 阈值才触发。
- [x] [Med] TOCTOU 竞态：Count 与 RetryAfter 之间事件可能过期 — 接受当前行为，fail-open 兜底保证最坏情况为 retryAfter 默认 1s。
- [x] [Low] ChurnGuardRetryAfter Gauge 并发覆盖 — 接受，指标用于趋势观察不需精确分布。
- [x] [Low] 重复定义 retryAfterProvider 接口 — 接受，Go narrow interface 惯用写法。
- [x] [Low] RefreshPoolPressureSnapshot 导出函数使用未导出参数类型 — 接受，实际调用方通过 adapter factory 传入无编译问题。
- [x] [Spec] REINSTALLING 状态被计入 resetting 但 spec 未定义 — 已补充：`REINSTALLING` 与 `RESETTING` 一样归入“尚不可复用”的 resetting bucket。
- [x] [Spec] 快照过期判定加了 2 秒 fudge，spec 未提及 — 已补充：文档和代码注释均注明实际 stale 判定窗口为 `pressure_snapshot_ttl_seconds + 2s`。

### Review Follow-ups (AI)

- [x] [AI-Review] [High] RetryAfter 取 min — 审查误判，min 是正确语义，已补代码注释
- [x] [AI-Review] [High] Snapshot Refresher 单个 pool 失败 — 已修复
- [x] [AI-Review] [High] destroy_accepted 重复记录 — 已修复
- [x] [AI-Review] [Med] Bypass stale HOT snapshot — 已补 Known Limitations 说明
- [x] [AI-Review] [Med] 配置边界值缺少校验 — 已修复
- [x] [AI-Review] [Med] desiredCapacity=0 误判 HOT — 接受当前行为
- [x] [AI-Review] [Med] TOCTOU 竞态 — 接受当前行为
- [x] [AI-Review] [Low] Gauge 并发覆盖 — 接受
- [x] [AI-Review] [Low] 重复 retryAfterProvider 接口 — 接受
- [x] [AI-Review] [Low] 导出函数未导出参数类型 — 接受
- [x] [AI-Review] [Spec] REINSTALLING 归类 — 已补充
- [x] [AI-Review] [Spec] fudge 容差 — 已补充

## Related Artifacts

- `docs/ctl-tech-specs/tech-spec-ctl-observability-enhancement.md`
- Story 实现记录（已从仓库删除，可从 git 历史恢复）：3-1、2-1、1-4
