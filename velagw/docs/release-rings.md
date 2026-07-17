# new-api 多 Set 版本发布

## 目标

LLMGateway 使用一个 Fleet 管理全部 Set。Fleet 内包含长期存在的发布环（Release Ring），不同发布环可以同时运行不同的 new-api Release：

```text
Fleet
├── Canary：少量 Set，运行候选版本
├── Early：部分 Set，运行已初步验证版本
└── Stable：大多数 Set，运行稳定版本
```

Release Ring 只负责编排多个 Set，不理解单 Set 内部切流。单 Set 升级继续由现有数据库感知状态机完成：升级 admin、验证旧 traffic 与新 Schema、创建 Green、探针、Redis 切流、排空 Blue。

## 真源与边界

- MySQL 是 Release、Ring、Rollout 和 Set 版本归属的真源。
- `llmgateway-release-rollout` 复用现有 `set_upgrade_batch/run`，不另建执行队列。
- Rollout 固定 `max_parallel=1`、`stop_on_failure=true`。
- KRO 只渲染已经解析好的 admin/traffic 镜像，不负责发布顺序。
- new-api 不需要修改。
- traffic 热路径仍然只读取 Redis 路由，不读取 Release/Ring 数据。

## 模型

### Release

`llmgateway_newapi_releases` 保存不可变版本。镜像必须固定到 `@sha256:<digest>`；同一 Release ID 不能修改版本、镜像、兼容性或状态，变更镜像必须创建新 Release。

允许状态：`draft`、`verified`、`stable`、`blocked`。只有 `verified/stable` 可以发布。当前自动发布只接受 `expand_compatible` 数据库变更，Schema 不自动回滚。

### Release Ring

`llmgateway_release_rings` 保存长期发布分组：

- `serving_release_id`：该 Ring 最近一次完整收敛的版本；
- `target_release_id`：当前 Rollout 的目标版本；
- `steady/rolling/degraded`：稳定、发布中、失败暂停；
- `admission_enabled`：是否可作为自动扩容的新 Set 归属；
- `ordinal`：发布顺序和默认稳定 Ring 选择依据。

Set 通过 `release_ring_id` 归属一个 Ring，并分别记录 `current_release_id` 与 `target_release_id`。Ring 的版本分布由 Set 实际状态聚合，不用一个字段掩盖发布中的混合版本。

### Rollout

创建 Rollout 时，系统只选择目标 Ring 内尚未到达目标 Release 的 active Set，按 `observed_user_count` 从低到高生成不可变快照，Set ID 作为稳定次序。快照写入现有升级 batch，每个 run 记录 sequence、from release 和 target release。

```text
Ring rollout
→ set-a 完整升级并排空
→ set-b 完整升级并排空
→ set-c
```

任一 run 失败或回滚，Rollout 进入 `paused`，Ring 进入 `degraded`，后续 pending run 不会被领取。重试成功后状态会从现有 run 自动重新聚合，不依赖管理页面轮询才能推进。

## 新 Set

容量控制器创建 provision request 时会选择同 Fleet 中 ordinal 最大且允许准入的健康 Ring：

- Ring 稳定时使用 `serving_release_id`；
- Ring 发布中时使用 `target_release_id`；
- `paused/degraded` Ring 不接收新 Set；
- 没有 Release Ring 时保留旧版 Fleet 默认镜像兼容行为。

provision request 固化 `release_ring_id`、`release_id` 和 `release_image`。set-manager 使用该 digest 创建 admin 和初始 traffic runtime，因此后续修改 Fleet 默认镜像不会改变这个 Set。

## 管理 API

```text
GET/POST /api/admin/newapi-releases
GET/POST /api/admin/release-rings
GET/POST /api/admin/release-rollouts
GET      /api/admin/release-rollouts/{id}
```

管理台「基础设施 → 版本发布」提供版本登记、Ring 建立、Set 分组、逐个发布和进度查看。

## 生产迁移

1. 扫描生产 LLMFleet 中现有 Set 的固定镜像 digest。
2. 为当前 digest 创建 stable Release。
3. 创建 Canary、Early、Stable Ring，并显式分配存量 Set。
4. 确认所有 Set 已回填 `current_release_id`，所有 provision request 能固化 Release image。
5. 再删除 KRO 中 `adminImage/legacyTrafficImage` 为空时回退 Fleet 全局镜像的兼容逻辑。
6. 使用新 digest 按 Canary → Early → Stable 创建 Rollout；每个 Ring 内保持 one by one。

删除全局镜像 fallback 是单独的生产迁移门禁，本期模型上线不会自动修改已有 LLMFleet。
