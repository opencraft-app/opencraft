# P0 运营商闭环

这一期把 LLMGateway 从“能代理多 Set”补到“能值班运营”。核心原则：

- 不修改 new-api。
- 不引入 Kafka、Temporal、ArgoCD 这类重型系统。
- 自动化状态全部落在 LLMGateway 自己的 MySQL。
- control、traffic 和四类 worker pool 可独立部署、独立扩容。

## 进程划分

- `llmgateway-control`：管理 API 和控制台，不暴露 `/v1/*`。
- `llmgateway-traffic`：只处理模型流量，不暴露管理 API；流量热路径只读 Redis route snapshot，不连接 LLMGateway MySQL。
- `llmgateway-worker-core`：Set、Fleet、渠道检查等低频控制任务，任务级 MySQL lease 保证同一任务跨 Pod 单例执行。
- `llmgateway-worker-byok`：按用户消费 BYOK 同步意图；同一用户严格串行、不同用户并行，并对每个 Set 设置并发上限。
- `llmgateway-worker-observer`：按 cursor 播种租户观测任务，再按用户并行刷新余额、订阅和套餐投影。
- `llmgateway-worker-maintenance`：执行用户删除等低频破坏性维护；按任务目标领取租约，并在删除 new-api 用户前先冻结 LLMGateway 租户写入。

四类 worker 使用同一个二进制和镜像，通过 `LLMGATEWAY_WORKER_POOL=core|byok|observer|maintenance` 选择职责。生产初始各两个副本；扩容 BYOK、observer 或 maintenance 不会增加 core 任务的重复执行。

## 流量路由快照

traffic 面的生产形态是 Redis-only，不允许 Redis miss 后回 MySQL 查询。control 面在签发、撤销 key、保存/同步 BYOK、停用租户等慢路径动作中维护 Redis route snapshot；traffic 收到 `/v1/*` 后只解析 key、读取 Redis、校验 secret hash，然后反代到目标 new-api Set。

新签发的访问密钥采用可路由格式：

```text
sk-<Base64URL(version + route_slot + key_id + secret)>
```

完整 Key 固定 95 字符，其中 Key ID 和 Secret 各为 256 bit。中央 MySQL 只保存 Key ID、完整 Key 哈希、Secret 哈希、路由槽和状态，不保存完整 Key；完整 Key 仅在 Redis 路由发布成功后返回一次。Redis、日志和指标同样不保存或输出完整 Key。Redis route key 使用 route slot hash tag：

```text
llmgateway:route:{kr-00000007}:key:<external_key_id>
```

snapshot 中包含 `set_base_url`、`upstream_key`、`route_mode`、`enabled` 等转发所需字段，因此 traffic 不需要读取 `llmgateway_sets`、租户表或 BYOK 表。route snapshot 是持久 Redis 记录，不使用短 TTL；禁用租户和撤销 key 会主动删除 snapshot，禁用 Set 会把该 Set 下的 snapshot 标记为 `enabled=false` 并保留密钥校验信息，BYOK 策略变化会刷新 snapshot。Redis 故障时 traffic 快速失败，不会把压力转移到 MySQL。

## 新增管理 API

管理 API 是 control 面能力，不走 `llmgateway-traffic`，也不使用模型调用的 `sk-...` 访问密钥。当前北京生产管理面入口是 `https://llmgw-control.lightvela.com`。给 `ctl`、`trade`、运营后台这类内部系统调用时，不需要也不应该传用户模型 key；用户模型 key 只用于 `/v1/*` 流量面。

生产部署上，管理 API 默认应只在内网或可信服务之间开放，由 VPC、服务间身份或上层网关策略保护。若直接暴露 `llmgateway-control` 的 `/api/admin/*` 路由，则仍应按部署策略使用 cluster admin token；不要把这个 token 给终端用户或 Agent 调用方。

当前生产 cluster admin token 存在 TKE Secret `llmgateway-runtime` 的 `CLUSTER_ADMIN_TOKEN` 字段里。文档和代码仓库只记录读取方式，不提交明文 token；具备集群权限的内部系统可从 Secret Manager / K8s Secret 注入运行时环境变量后调用管理 API。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/admin/overview` | 运营总览：Set、用户水位、渠道、告警、流量错误摘要 |
| `GET` | `/api/admin/background-jobs` | 独立后台任务页：任务、BYOK 队列、租户观测队列 |
| `GET` | `/api/admin/jobs` | 后台任务列表 |
| `POST` | `/api/admin/jobs/{name}/run` | 手动触发一次后台任务 |
| `GET` | `/api/admin/jobs/{name}/runs?after=<RFC3339>&limit=20` | 查询任务运行记录和 lease owner，用于恢复验证 |
| `POST` | `/api/admin/byok-sync/retry` | 把退避中的 BYOK 失败任务重新置为待处理，由 BYOK worker 消费 |
| `GET` | `/api/admin/tenant-statistics` | 读取 worker 最近一次租户数量统计快照 |
| `GET` | `/api/admin/tenants/{user_id}` | 租户完整详情 |
| `POST` | `/api/admin/tenants/{user_id}/actions/observe` | 刷新租户权益观测 |
| `POST` | `/api/admin/tenants/{user_id}/actions/sync-byok` | 重新同步 BYOK |
| `POST` | `/api/admin/tenants/{user_id}/actions/disable` | 停用租户 |
| `POST` | `/api/admin/tenants/{user_id}/actions/create-key` | 签发访问密钥 |
| `POST` | `/api/admin/tenants/{user_id}/actions/migrate-dry-run` | 迁移预演 |
| `POST` | `/api/admin/tenants/{user_id}/actions/migrate` | 执行迁移 |
| `POST` | `/api/admin/tenant-deletions/preview` | 按用户 ID、前缀或 Set 生成删除范围快照 |
| `GET` | `/api/admin/tenant-deletions` | 查询用户删除任务列表和进度 |
| `GET` | `/api/admin/tenant-deletions/{job_id}` | 查询单个用户删除任务 |
| `POST` | `/api/admin/tenant-deletions/{job_id}/start` | 使用预览数量、摘要和幂等键确认删除 |
| `GET` | `/api/admin/tenant-deletions/{job_id}/failures` | 查询删除失败的用户 |
| `POST` | `/api/admin/set-decommissions/preview` | 检查 Set 占用并生成销毁摘要 |
| `GET` | `/api/admin/set-decommissions` | 查询 Set 销毁任务 |
| `POST` | `/api/admin/set-decommissions` | 默认注销空 Set，或显式启动单 Set 级联销毁 |
| `POST` | `/api/admin/set-decommissions/{job_id}/cancel` | 在 set-manager 领取前取消注销 |
| `POST` | `/api/admin/set-decommissions/{job_id}/retry` | 保留 runtime lease，重新执行失败的清理 Job |
| `GET` | `/api/channel-bundles/{id}/revisions` | 渠道模板版本历史 |
| `GET` | `/api/channel-bundles/{id}/releases` | 渠道模板发布历史 |
| `POST` | `/api/channel-bundles/{id}/releases` | 批量发布到 Set，默认失败即停 |
| `POST` | `/api/channel-bundles/{id}/rollback` | 用历史版本创建新的当前版本 |
| `GET` | `/api/channel-bundle-releases/{run_id}` | 查看单次发布 run |
| `GET` | `/api/plans` | 查看全部权益模板 |
| `POST` | `/api/plans` | 幂等写入不可变权益模板；同 ID 不同权益返回 409 |
| `GET` | `/api/plans/{plan_id}/sets` | 查看各服务集群的下发状态 |
| `GET` | `/api/plans/{plan_id}/periods` | 查看允许的非默认购买周期 |
| `POST` | `/api/plans/{plan_id}/periods` | 登记非默认周期并排队下发到 active Set |
| `GET` | `/api/plans/{plan_id}/periods/sets` | 查看周期变体在各服务集群的下发状态 |
| `POST` | `/api/plans/{plan_id}/sync` | 重试尚未完成的集群下发 |

权益模板写入后由 `sync_plans` 后台任务调用 new-api 管理 API 下发。新 Set 初始化会同步全部启用模板；用户订阅发放只选择目标模板已经“已就绪”的 Set。模型范围、倍率和限流不属于权益模板，由 new-api 模型配置承接。

## 用户删除与 Set 销毁

用户删除是显式的两阶段操作，不等同于“停用租户”：

1. 调用 `POST /api/admin/tenant-deletions/preview` 选择用户，worker 把目标物化成固定快照。
2. 等任务进入 `previewed` 后，调用 start，并原样带回 `target_count`、`target_digest` 和新的 `idempotency_key`。
3. control 在同一事务中把目标租户置为 `deleting`，后续签发密钥、订阅、BYOK、观测等写入都会被拒绝。
4. maintenance worker 删除 new-api token/channel/user，再清理 LLMGateway 的 key route snapshot、绑定、权益投影和租户记录。

自动化工具不要跳过 preview，也不要自己猜摘要。单次 `user_ids` 最多 1000 个；大批量清理优先使用 `user_id_prefix` 或 `set_id`，由 worker 使用 cursor 物化，避免 HTTP 请求扫描全表。任务按目标 at-least-once 执行；进度和失败项分别从任务详情和 failures API 获取。

Set 销毁同样必须先 preview，并在启动时原样带回 `expected_digest`。默认模式只允许完全空闲的 Set；测试 Set 或整 Set 退役可显式设置 `cascade_tenants=true`。级联模式先把 Set 置为 `draining`，拒绝新用户和新任务，maintenance worker 批量撤销 Redis 路由并清理 LLMGateway 本地租户投影，然后才把任务交给 set-manager。它不会为每个用户调用 new-api；真正的数据回收是一次性清空该 Set 的 Redis DB、删除专属 MySQL database。

没有 runtime lease 的历史孤儿 Set 必须先停用，并额外设置 `allow_orphan=true`。该模式只清理控制面投影，因为没有可信的数据库和 Redis 定位信息。存在用户删除任务、活跃 Set 操作租约或多份 runtime lease 时，一律拒绝强制销毁。管理台仍要求手工输入完整 Set ID；API 不提供 `all=true`。

```json
{
  "set_id": "set-loadtest-0001",
  "expected_digest": "<preview 返回值>",
  "idempotency_key": "cleanup-loadtest-0001-20260714",
  "cascade_tenants": true,
  "allow_orphan": false
}
```

启动后状态依次为 `purging_tenants -> pending -> removing_runtime -> cleaning_runtime -> finalizing -> cleanup_ack_pending -> succeeded`。`purging_tenants` 只由 maintenance worker 消费；set-manager 的内部查询不会返回这一阶段，避免本地投影尚未清空时提前删除运行时。

`pending` 注销可以取消，恢复到原来的 `active/disabled` 状态。set-manager 已领取后禁止取消；cleanup Job 达到 Kubernetes 重试上限后，任务进入 `error`，移除失败的 cleanup 声明，但保留 runtime lease、Set 的 `draining` 状态和存储，不自动放量，也不做“猜测式成功”。运营人员确认原因后调用 retry；新的 attempt 会创建新的 cleanup Job，Set 不需要重新加入 Fleet。

用户删除目标失败后按 30 秒退避自动重试，单个用户最多 5 次；达到上限后保留在 failures 列表，不会在单轮 worker 中无限重打 new-api。

## 后台任务

默认任务由服务自动初始化：

- `refresh_tenant_statistics`：按 backend/status 聚合租户数量并写固定快照；HTTP 列表不再现场执行全表 COUNT。
- `refresh_tenant_observations`：按持久 cursor 扫描租户，只负责向观测任务表补齐意图，不直接扇出 new-api。
- `refresh_set_capacity`：按本地绑定数刷新每个 Set 的用户水位投影。
- `check_set_admission`：检查新 Set 是否完成准入；只有通过后才可接新用户。
- `check_channel_drift`：对 active Set 做渠道模板只读检查。
- `reconcile_group_ratios`：扫描本地 `pending/error` Set，把权威 `GroupRatio` 快照完整下发到 new-api。
- `reconcile_set_facts`：消费 Set facts，自动纳管新 Set。
- `cleanup_pending`：清理超时 pending 的扩容/纳管意图。

core 和 observer 的播种任务使用 `llmgateway_worker_jobs` 的 `lease_owner`、`lease_until` 做互斥。任务执行记录保存在 `llmgateway_worker_job_runs`，用于排障，不作为审计系统。旧的 `retry_byok_sync` 全局任务会被自动禁用并从运营列表隐藏。

BYOK 同步是异步状态机：保存用户设置或调用 `sync-byok` 只会更新本地 desired state、把 enabled provider 标记为 `pending`，并对 `llmgateway_byok_sync_tasks.requested_version` 加一。BYOK worker 抢到用户级 lease 后记录 `processing_version` 并执行真实 new-api 写入；如果运行中同一用户又保存了新配置，不会被第二个 worker 并发抢跑，旧版本完成后任务会回到 `pending` 继续应用新版本。旧版本失败但已有新版本入队时，也不会进入长退避，而是立即留在 pending，让最新意图尽快生效。

BYOK worker 按 Set 公平领取任务，并使用 `llmgateway_set_operation_leases` 约束跨 Pod 的每 Set 并发。`byok_*` 是保留的 GroupRatio 命名空间：平台渠道发布和用户 BYOK 修改都只写 LLMGateway MySQL 意图，统一 reconciler 从本地完整快照生成一次 `PUT GroupRatio`，不会读取 new-api 内存 JSON 参与合并。已记录 `remote_channel_id` 的 provider 优先按 ID 更新，不再对几十万渠道执行名称 LIKE 搜索。同步成功后由 BYOK worker 刷新 Redis route snapshot，因此 BYOK pool 必须配置 `LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL`。

`refresh_tenant_observations` 使用 `llmgateway_worker_jobs.scan_cursor` 持久化扫描水位（API 字段仍叫 `cursor`），每轮按 cursor 拉取一批租户并写入 `llmgateway_tenant_observation_tasks`，扫到尾部后清空 cursor，从头开始下一轮。observer worker 再消费用户任务：活跃订阅约每小时刷新，非活跃租户约每六小时刷新，并加入确定性抖动避免整点洪峰。disabled、unready 或不存在的 Set 会进入短期 `blocked`，不会继续打 new-api。这样 1 万、10 万租户不会长期停在第一页；如果 cursor 因升级或人工改库变成非法值，worker 会自动清空并重新开始扫描。

BYOK 与观测任务都是 at-least-once 状态机，领取、续租、完成均校验 `lease_owner + processing_version`。Pod 收到 SIGTERM 时停止领取并主动释放未完成租约，避免滚动升级后只能等待五分钟 TTL。各 pool 还必须显式限制 MySQL 连接池、全局并发和每 Set 并发，不能用 Pod 数量无界放大 new-api 管理面压力。

Set 容量准入使用 `SetCapacityPicker` 读取 `llmgateway_sets.observed_user_count` 作为水位投影，不在新用户分配时现场 `COUNT(*) GROUP BY set_id`。绑定创建成功后会 best-effort 把该投影加一；`refresh_set_capacity` 再定期用真实绑定数校准 `observed_user_count` 和 `capacity_updated_at`。这个设计允许短时间轻微超卖，但能避免新用户批量进入时把用户绑定表打成热聚合。每个 Set 可配置：

- `max_users`：单 Set 用户上限，0 表示不限量。
- `warn_users`：预警线，达到后总览产生 warning。
- `reserved_users`：预留用户位，不参与新用户准入。

新用户分配会跳过 disabled、draining、未初始化和投影已满水位的 Set；如果没有可接人的 Set，控制面返回明确错误，等待扩容、worker 校准或人工调整水位。Redis db0 可以作为未来候选集缓存，但第一版不把 Redis 当容量真源，避免引入额外一致性恢复逻辑。

## Set 准入检查

Set 的“已纳管”和“可承载流量”是两件事。云原生 facts/reconcile 路径会把新增 Set 显式标记为 `admission_status=pending`；`check_set_admission` 任务通过后才更新为 `passed`。用户分配、容量水位、总览 ready 统计都会跳过 `pending/checking/failed` 的 Set。

checker 按“最后稳定 applied revision”做强校验：

- Set 必须 `active + setup + admin token`。
- 新 Set 的所有渠道包都必须至少完成一次完整发布，存在非空 `applied_fingerprint`；首次同步未完成时严格禁止准入。
- 已准入 Set 保存新 revision 或处于发布中时，可以保持 `pending` 并继续接收新用户；checker 校验最后稳定的 applied revision，不要求它立即追上当前 desired fingerprint。
- applied revision 中启用渠道的模型，必须同时存在 `ModelRatio` 和 `CompletionRatio`。
- `drift/conflict/error` 表示远端已无法确认仍处于稳定版本，该 Set 单独退出新用户准入；其他 Set 不受影响。

未通过时会写入 `admission_error` 和 `admission_checked_at`，运营台会显示“待准入/检查中/准入失败/准入通过”。手工纳管的历史 Set 如果没有 admission 字段，暂按兼容模式视为可服务；生产新增 Set 应统一走 facts/reconcile，让 admission 显式受控。

## 渠道发布模型

渠道模板保存或从黄金 Set 导入时，会生成不可变 revision：

- revision 保存脱敏 spec 和 fingerprint。
- 当前模板仍保留密钥，用于实际发布。
- 保存 revision 只推进 desired state，不改变任何已准入 Set 的 admission；发布成功后才更新该 Set 的 `applied_fingerprint`。
- 发布 run 始终携带选中的不可变 revision 快照。即使保存了更新版本，历史 revision 发布也不会穿透成当前版本。
- 发布失败后会读取远端 options 和 channel 状态，与旧 applied revision 复核：仍等于旧稳定版本时保持 `pending` 并继续准入；确认发生半更新、漂移或无法证明安全时，仅隔离该 Set。
- 回滚不是覆盖历史，而是从历史 revision 创建一个新的当前模板版本；由于 revision 不保存明文密钥，回滚会从当前模板按 channel id 补齐密钥，补不齐或 key hash 不匹配时会失败，需要先从黄金 Set 重新导入或重新保存密钥。
- 发布 run 记录每个目标 Set 的状态，`stop_on_failure=true` 默认开启。
- 同一渠道模板的保存、单 Set 覆盖、批量发布、回滚使用 bundle 级 MySQL lease 互斥；并发操作返回 `409 Conflict`，避免两个运营动作交错写远端 Set。

## 运营总览

总览页只读 LLMGateway MySQL 投影，不实时扇出所有 new-api Set。需要远端检查的动作通过 worker 或手动按钮触发。

首屏展示：

- Set 健康、用户数、水位。
- 渠道模板同步状态。
- BYOK 同步队列和租户观测队列，包括最老等待、过期租约、最近成功/失败。
- 后台任务状态。
- 本地告警摘要。
- 流量错误摘要。

## 指标与告警

`/metrics` 已包含：

- `llmgateway_set_ready`
- `llmgateway_set_runtime_ha_ready`
- `llmgateway_set_runtime_ha_desired_replicas`
- `llmgateway_set_runtime_ha_ready_replicas`
- `llmgateway_set_runtime_ha_pdb_ready`
- `llmgateway_set_users`
- `llmgateway_set_max_users`
- `llmgateway_set_free_users`
- `llmgateway_set_accepting_new_users`
- `llmgateway_channel_bundle_sync_state`
- `llmgateway_group_ratio_apply_state`
- `llmgateway_group_ratio_desired_version`
- `llmgateway_group_ratio_applied_version`
- `llmgateway_group_ratio_version_lag`
- `llmgateway_worker_job_last_success_timestamp_seconds`
- `llmgateway_worker_job_failure_total`
- `llmgateway_worker_job_lease_age_seconds`
- `llmgateway_key_route_cache_total`
- `llmgateway_byok_sync_failure`
- `llmgateway_byok_sync_tasks`
- `llmgateway_byok_sync_oldest_pending_age_seconds`
- `llmgateway_byok_sync_expired_running_leases`
- `llmgateway_byok_sync_last_success_timestamp_seconds`
- `llmgateway_byok_sync_last_failure_timestamp_seconds`
- `llmgateway_tenant_observation_tasks`
- `llmgateway_tenant_observation_due_tasks`
- `llmgateway_tenant_observation_oldest_due_age_seconds`
- `llmgateway_tenant_observation_expired_running_leases`
- `llmgateway_tenant_observation_last_success_timestamp_seconds`
- `llmgateway_tenant_observation_last_failure_timestamp_seconds`
- 原有 `llmgateway_traffic_*`

Prometheus 告警示例见 [prometheus-rules.yaml](./prometheus-rules.yaml)。
