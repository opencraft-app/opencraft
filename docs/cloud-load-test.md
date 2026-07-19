# 云上压测场景

本文记录 LLMGateway 在 TKE 生产形态下的可复现压测场景。压测目标不是单纯追求峰值，而是把控制面、流量面、BYOK、续费发放拆开验证，方便定位瓶颈。

## 运行前提

- `llmgateway-control`、`llmgateway-traffic`、`llmgateway-worker-core`、`llmgateway-worker-byok`、`llmgateway-worker-observer` 分离部署。
- 至少两个可纳管 new-api Set。
- Go 版 OpenAI-compatible mock upstream 已部署，例如 `cloud-mockllm:8080`。
- 平台渠道包、模型倍率、套餐已完成初始化。

压测 runner 通过环境变量控制场景：

| 变量 | 说明 |
| --- | --- |
| `LOAD_PROFILE` | 云上生产环境必须为 `cloud_prod`；本地 Compose 使用 `local` |
| `LOAD_SCENARIO` | 场景名，见下方场景矩阵 |
| `LOAD_LLMGATEWAY_BASE_URL` | control 服务地址 |
| `LOAD_LLMGATEWAY_TRAFFIC_BASE_URL` | traffic 服务地址 |
| `LOAD_USERS` | 用户数量 |
| `LOAD_USER_ARRIVAL_INTERVAL` | 用户到达间隔 |
| `LOAD_RUN_DURATION` | 单轮持续时间 |
| `LOAD_BYOK_PROVIDERS_PER_USER` | 每个用户配置的 BYOK provider 数 |
| `LOAD_SUBSCRIPTION_APPLICATIONS` | 每个用户重复发放订阅次数 |
| `LOAD_PREPARE` | 是否执行纳管、渠道包、套餐初始化 |

## 本地与云上边界

云上 profile 使用 `LOAD_MAX_CONCURRENT_USERS=60` 作为硬上限。`LOAD_USERS` 仍表示本次
需要覆盖的总用户数；超过 60 的用户会等待前一批完成，不会继续放大生产控制面并发。
该限制不修改 new-api 的模型限流、资源保护或其他生产参数。

本地压测用于验证功能和寻找极限，可以通过显式设置
`LOAD_DISABLE_NEWAPI_PROTECTION=true` 暂时关闭 new-api 的 CPU、内存和磁盘保护。
默认不会修改这些阈值。

云上生产压测必须设置以下安全参数：

```bash
LOAD_PROFILE=cloud_prod
LOAD_PREPARE=false
LOAD_CHAT_MODEL=<专用压测模型 ID>
```

`cloud_prod` 会在进程启动前拒绝以下配置：执行 `prepare`、关闭 new-api
资源保护、使用空模型或 `auto` 模型。云测只产生用户和请求，不负责修改 Set、渠道包、
倍率、资源保护或限流配置。压测专用模型及渠道应通过正常控制面流程提前发布。

生产 Set 中关闭 `GLOBAL_API_RATE_LIMIT_ENABLE`、`GLOBAL_WEB_RATE_LIMIT_ENABLE`、
`CRITICAL_RATE_LIMIT_ENABLE` 和 `SEARCH_RATE_LIMIT_ENABLE` 是托管架构本身的部署策略，
不是压测开关；模型级限流和上游渠道限流仍应按生产参数保留。

## 场景矩阵

| 场景 | `LOAD_SCENARIO` | 验证重点 |
| --- | --- | --- |
| 混合并发 | `mixed_concurrent` | 用户发放、发 key、BYOK 配置和聊天并发发生，贴近真实启动期 |
| 平台渠道流量 | `platform_only` | 不配置 BYOK，只压平台渠道和 traffic 反代 |
| BYOK 后聊天 | `byok_then_chat` | 先同步用户 BYOK，再验证用户私有渠道可用于聊天 |
| BYOK 同步专测 | `byok_sync_only` | 不发聊天，只压保存和同步 BYOK 设置 |
| 续费突发 | `renewal_burst` | 单用户多次订阅发放后再聊天，模拟续费/补发 |

## 2026-07-08 云上结果

环境：北京 TKE Serverless，2 个 new-api Set，4 副本 Go mock upstream。以下新增场景使用 200 用户、50ms 到达间隔、3 分钟聊天窗口。

| 场景 | 请求量 | 成功 | 错误 | 延迟 |
| --- | ---: | ---: | ---: | --- |
| `platform_only` | 11,325 | 11,322 | 3 | p50 45ms / p95 79ms / p99 120ms |
| `byok_sync_only` | 200 用户 x 3 provider | 全部完成 | 0 | 控制面同步 81s 完成 |
| `byok_then_chat` | 9,823 | 9,819 | 4 | p50 48ms / p95 94ms / p99 155ms |
| `renewal_burst` | 11,301 | 11,298 | 3 | p50 48ms / p95 87ms / p99 121ms |

补充：之前 `mixed_concurrent` 1000 用户云测结果为 139,557 次聊天请求、139,537 成功、20 次聊天超时、501 次用户链路错误。优化 BYOK 同步锁后，200 用户 BYOK 专测已无同步错误。

## 当前观察

- 成功请求延迟稳定，p99 处于百毫秒级。
- 带聊天场景均出现极少量 `llmgateway-traffic` 30s context deadline exceeded。
- 这类错误不是普遍慢请求，更像少量请求在代理/upstream 连接路径卡住；需要后续用 Prometheus 指标和 access log 聚合定位具体 Set、key、upstream。
- TKE 容器 stdout 日志偶发无法拉取，压测报告已通过 termination message 兜底；后续建议增加 runner 结果回写 control 的能力。

## 2026-07-11 生产参数 2 万用户结果

本轮先发布独立预编译 load-runner 镜像，并强制使用
`LOAD_PROFILE=cloud_prod`、`LOAD_PREPARE=false` 和专用模型
`llmgw-mock-chat`。5 用户 smoke 的 10 次聊天全部成功，随后执行 2 万用户
`byok_then_chat` 场景：20ms 用户到达间隔、每用户 2 个 BYOK、每用户 18 次聊天、
聊天间隔 10s。

| 指标 | 结果 |
| --- | ---: |
| 用户链路成功 | 13,563 |
| 用户链路失败 | 6,437 |
| chat 成功 | 244,134 |
| chat 失败 | 0 |
| chat p50 / p95 / p99 | 31ms / 3,084ms / 4,602ms |
| chat 最大延迟 | 10,457ms |
| runner 实际运行时间 | 9m28s |

`244134 = 13563 x 18`，说明完成注册和订阅的用户全部完成了预期聊天请求。
6,437 个用户均在 `POST /api/internal/subscriptions/apply` 等待响应超过 120s，
因此本轮先达到瓶颈的是注册/订阅控制面，而不是 traffic 反代。

本轮同时确认两个 P0 运营问题：

- 单 worker 串行执行任务，`check_channel_drift` 对大量 Set 逐个远端检查时会长期占住
  worker，导致 `retry_byok_sync` 等任务饥饿。测试开始前已有约 8.3 万 BYOK pending，
  不能用本轮判断队列最终消化速度。
- set-manager 没有读取 `LLMGATEWAY_SET_MANAGER_CAPACITY_ENABLED`，即使环境变量为
  `false` 仍会每分钟执行容量 reconcile。本轮 Fleet 从 49 增至 52 Set，新增并纳管
  `set-auto-000049` 至 `set-auto-000051`。

## 2026-07-11 worker 隔离修复后回归

修复上线后使用完全相同的生产参数再次执行 2 万用户 `byok_then_chat`。本轮不修改
new-api 保护阈值、模型限流或渠道配置。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 用户链路成功 | 13,563 | 6,281 |
| 用户链路失败 | 6,437 | 13,719 |
| chat 成功 | 244,134 | 113,058 |
| chat 失败 | 0 | 1 |
| chat p50 / p95 / p99 | 31 / 3,084 / 4,602ms | 20 / 35 / 44ms |
| chat 最大延迟 | 10,457ms | 203ms |
| runner 实际运行时间 | 9m28s | 9m16s |

两个目标修复均已在生产运行态验证：

- 渠道漂移检查按持久 cursor 分批执行，单个 Set 检查有 5s 超时。漂移检查连续超时期间，
  `retry_byok_sync`、容量刷新和容量 reconcile 仍独立运行；BYOK 成功数从 12,764
  增至 13,764，完整完成一个 1,000 条批次。
- set-manager 已删除容量 reconcile 调用和全部容量环境变量。压测期间 Fleet 从 52
  增至 54 Set，扩容 request 由 worker 的容量任务生成，set-manager 只负责消费 request
  并更新 `LLMFleet`。

本轮全链路仍未通过。20,000 个租户本地记录均已创建，但 13,719 个用户在向目标
new-api Set 创建用户时等待 120s 后超时。OTel span 将阻塞定位到
`newapi.admin_create_user`，主要集中在 `set-auto-000044`、`000049` 至 `000052`；这与
worker 调度隔离无关，下一步需要分别核对这些 Set 的 admin Service、new-api 数据库
连接池和共享 Shard MySQL 连接水位。唯一一次 chat 失败是目标 Set 对
`llmgw-mock-chat` 无可用渠道，需要同时检查新 Set 准入与渠道发布完成条件。

## 2026-07-12 连接池与订阅闸门回归

生产 Fleet 的 60 个 Set 已统一使用 admin/traffic `max_open_conns=32`、
`max_idle_conns=2`、`max_lifetime=60s`，每 Set 订阅写并发为 8。滚动升级后聚合检查了
180 个 new-api Deployment，全部处于 Ready/Updated 状态且配置一致。

先执行 5 用户 smoke，10 次聊天全部成功；随后执行 600 用户 `renewal_burst`：
最多 60 个用户并发，每用户连续发放 3 次订阅并完成 2 次聊天。云上 profile 保持
`LOAD_PREPARE=false`，没有关闭 new-api 的资源保护、模型级限流或渠道限流。

| 指标 | 结果 |
| --- | ---: |
| 用户 | 600 |
| 并发上限 | 60 |
| 订阅发放 | 1,800 次，全部成功 |
| chat | 1,200 次，全部成功 |
| chat p50 / p95 / p99 | 55ms / 105ms / 132ms |
| chat 最大延迟 | 163ms |
| 运行时间 | 50s |

回归结束后，60 个 active Set 均为 healthy，runtime 投影仍为 `32/32/8`，Set 健康、
容量、准入和 fact reconcile 后台任务持续成功。生产中仍有一批早于本轮测试产生的
BYOK 重试任务报 `invalid access token`；本轮不写 BYOK 队列，该问题独立跟踪，不影响
本次订阅写路径和 traffic 路径的验收结论。

最后将 `llmgateway-traffic` 两个副本滚动到与 control/worker 相同的发布镜像。升级期间
始终保留两个可用副本；升级后再次执行 5 用户 smoke，10 次聊天全部成功，p95 76ms、
最大延迟 92ms。

## 自动扩 Set 云上验证

2026-07-09 已在北京 TKE 验证自动扩 Set 闭环：

1. 临时将容量策略设为 `max_users_per_set=50`、`min_ready_free_users=300`、`max_scale_up_per_cycle=1`。
2. `llmgateway-set-manager` 调用 `/api/admin/set-capacity/reconcile` 生成扩容 request。
3. set-manager 将 pending request 采纳进 `LLMFleet.spec.sets`，由 kro/RGD 展开 new-api Service 和 Deployment。
4. `LLMFleet` Ready 后，set-manager 写入 Set reconcile fact 并触发 control 纳管。
5. control bootstrap 新 Set，同步渠道包，下发已有权益模板，并补齐该 Set 的下发状态。
6. 用户发放订阅后，capacity picker 将新用户分配到自动扩出来的 Set，traffic 调用 `/v1/chat/completions` 成功。

本次自动扩出：

| Set | Shard | Redis DB | 状态 |
| --- | --- | ---: | --- |
| `set-auto-000001` | `shard-a` | 10 | `managed` / `admission passed` |
| `set-auto-000002` | `shard-b` | 11 | `managed` / `admission passed` |

验证用户结果：

| 用户 | 分配 Set | 状态 | 聊天 |
| --- | --- | --- | --- |
| `autoscale-e2e-ok-...-01` | `set-auto-000001` | `token_ready` | `chatcmpl-cloud-load` |
| `autoscale-e2e-ok-...-02` | `set-auto-000002` | `token_ready` | `chatcmpl-cloud-load` |
| `autoscale-e2e-ok-...-03` | `set-auto-000001` | `token_ready` | `chatcmpl-cloud-load` |

期间发现并修复两个问题：

- `redis_db` 在 API 返回中是字符串，set-manager 已兼容字符串解析。
- 新 Set 纳管后需要为已有 active Plan 自动创建 upstream plan，并把 Set Plan 标记为 ready；否则新用户不会分配到新 Set。
- provision request 的 `max_users_per_set` 需要回填到 Set registry 的 `max_users`，否则扩出的 Set 会被当成无限容量。
- 生产云测后续只走 `LLMFleet` runtime backend，经典 direct Kubernetes runtime 路径已移除。

## LLMFleet 云上验证

2026-07-09 追加验证 `LLMFleet` runtime backend：

1. 安装 kro `0.8.5`，并把 amd64 controller 镜像镜像到 TCR。
2. 应用生产 `LLMFleet` RGD，创建 `prod` Fleet。
3. `prod` Fleet 展开 `prod-set-a-newapi`、`prod-set-b-newapi`，两个 Deployment 均 Ready。
4. `llmgateway-set-manager` 只使用 `LLMFleet` runtime backend。
5. 人为触发低水位扩容，set-manager 将 `set-llmfleet-auto-000001` 追加进 `LLMFleet.spec.sets`。
6. kro 展开 `prod-set-llmfleet-auto-000001-newapi`，Deployment Ready。
7. 再次运行 set-manager Job，完成 facts 同步和 control 纳管触发。

本轮发现两个生产注意点：

- kro `0.9.2` 在当前 TKE apiserver 上会因为 `GraphRevision` 字段选择器失败，暂定使用 `0.8.5`。
- `llmfleet.yaml.template` 只能作为 bootstrap 模板；反复 apply 会覆盖 `spec.sets`，删除动态扩出来的 Set。shard 变更应使用 `deploy/k8s/prod/patch-llmfleet-shards.sh` 只 patch `spec.shards`，或先导出完整 Fleet 再发布。
