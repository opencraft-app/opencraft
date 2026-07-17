# LLMGateway 当前状态

> 更新时间：2026-07-07

LLMGateway 已经进入可验证的多 Set 运行阶段。当前实现覆盖 Set 纳管、Tenant 主表、provisioning 入口、subscription facade、key 路由、channel desired state、管理控制台和可复现 E2E。

## 已实现能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Set 纳管 | 已实现 | `GET/POST /api/sets` 注册已有 new-api Set，`POST /api/sets/{id}/bootstrap` 初始化空 Set root/admin token |
| 云原生 Set facts | 已实现 | `POST /api/admin/set-reconcile-facts` 只记录 kro/Fleet 观测事实；`POST /api/admin/set-reconcile-facts/reconcile` 消费 pending facts 后注册并 bootstrap Set |
| Set 容量水位 | 已实现 | `POST /api/admin/set-capacity/reconcile` 根据用户绑定数和水位生成扩 Set request；单 Set 用户上限、目标使用率、最低预留用户位可在管理台手动调节，也可通过 set-manager 环境变量自动调节；Redis DB 按 `[redis_db_start, redis_db_limit)` 分配并跳过已占用值，支持显式 `0..1` 的 DB0-only 云 Redis；`GET/POST /api/admin/set-provision-requests` 供 set-manager 消费和回写状态 |
| 管理员登录 | 已实现 | `POST /api/admin/login` 返回 LLMGateway cluster admin token |
| 用户绑定 | 已实现 | 外部 `user_id` 绑定到一个 Set 和 new-api upstream user |
| Tenant 主表 | 已实现 | `llmgateway_tenants` 是租户库存和 pending/new 开通真源；assignment API 写入时同步主表，未知用户默认 pending；`backend=new` 必须有 `set_id`，pending 和非 active Tenant 拒绝流量 |
| UserBinding provisioning | 已实现 | `allocated/user_ready/token_ready/failed` 显式记录纳管阶段和最近失败原因 |
| 外部 key | 已实现 | LLMGateway 签发外部 key，内部映射到 new-api upstream token 和 Set |
| /v1/* 流量代理 | 已实现 | 只解析 Authorization，校验 Tenant active，替换 upstream key，不解析 chat payload |
| 未知 key 拒绝 | 已实现 | 未命中本地 key binding 时返回 401，不代理其他网关 |
| 控制面/流量面拆进程 | 已实现 | `cmd/llmgateway` 保持全量本地入口，`cmd/llmgateway-control` 不暴露 `/v1/*`，`cmd/llmgateway-traffic` 只暴露 `/v1/*`、`/healthz`、`/readyz` 和可选 e2e hooks |
| subscription facade | 已实现 | apply/cancel/extend/get-active 兼容 ctl 形状，new 用户调用目标 Set 的 new-api |
| credit facade | 已实现 | 已开通用户读 new-api active subscription 聚合视图，pending 用户返回明确错误 |
| 订阅权益模板 | 已实现 | 不可变 Plan 保存业务权益定义，worker 异步下发到各 Set；只有下发 ready 的 Set 才能承接对应用户准入 |
| migration CGI | 已实现 | dry-run 和 migrate；迁移最后一步才写 assignment，并同步 Tenant 主表 |
| tenant list | 已实现 | 管理台用 cursor pagination 扫描 Tenant 主表，展示 binding/key 计数和最近 observation projection，不逐个扇出请求 new-api |
| tenant state | 已实现 | 管理台按需聚合 Tenant、Set、upstream user、active subscription、余额 |
| tenant observation projection | 已实现 | `POST /api/admin/users/{user_id}/observe` 刷新 plan、subscription、credit、period 摘要；observation 只是缓存，不单独成为库存来源 |
| channel spec | 已实现 | 保存 OpenAI-compatible provider desired state，明文 key 不回显 |
| channel sync | 已实现 | 手动同步到一个或全部 Set；check_only 做漂移检查；force_drift 覆盖漂移 |
| 用户级 LLM 设置 | 已实现 | `GET/PUT /api/internal/users/{user_id}/llm-settings` 保存用户路由和 BYOK provider；`POST /sync` 显式同步到目标 Set 私有 group/channel/token；流量代理按 `byok_first/platform_first` 选择 upstream token |
| resource admin | 已实现 | `GET /api/admin/resources` 暴露受控资源白名单；行读取脱敏密钥；PATCH 只允许 editable 字段；状态变化走 action |
| 管理控制台 | 已实现 MVP | React + shadcn/ui 风格控制台，含 Set、Tenant、Channel、Traffic Probe 等页面 |
| new-api 控制台嵌入 | 已实现运行态 | service worker / iframe 嵌入方式已打通基础路径 |
| 优雅停机 | 已实现 | SIGTERM 后 readiness 变 503，等待慢请求后退出 |
| 请求级观测 | 已实现 | `/v1/*` 记录结构化 access log，并在 `/metrics` 暴露 Prometheus 文本指标；标签含 external key id/hash prefix、Set、status、upstream status、streaming、error type，另有 duration ms sum/count |
| 可复现 E2E | 已实现 | Compose 启动两个 new-api Set + MySQL/Redis + `mockllm` OpenAI-compatible upstream，并验证配置包 option + channel 同步后真实聊天可用；覆盖 tenant observation 投影、远端漂移、force overwrite、禁用 Set skip、partial failure 不污染健康 Set、control/traffic 拆进程闭环、网关重启和 traffic 独立重启后状态可用 |
| 业务画像压测 | 已实现 | Compose `load` profile 提供 Go load-runner，默认 1000 用户、2 个 BYOK、4 个平台 channel |

## 已确认的设计判断

- new-api 的 subscription 和 quota 模型足够承接“大模型积分/订阅权益”的执行面。
- LLMGateway 不重建完整余额账本，只保存跨 Set 映射、兼容投影和 period_end overlay。
- Tenant observation projection 是运营视图缓存，不参与扣费、不作为权益真源。
- 续费可以用新增 new-api subscription 表达，不要求复用同一个 new-api subscription id。
- upstream new-api token 建议使用 `unlimited_quota=true`，真实权益扣在 subscription，避免 token quota 和 subscription quota 双重限制。
- channel desired state 属于 LLMGateway 平台层，new-api 只负责单 Set 内 channel 实体。
- 用户 BYOK 通过用户私有 new-api group/channel/token 表达；保存本地设置不自动改远端，显式 sync 才写目标 Set。流量面只按策略选择 token，不解析 payload，也不做跨 token 请求重试。

## 主要未完成项

| 项目 | 影响 | 建议 |
| --- | --- | --- |
| 管理台租户详情增强 | 运营效率不足 | 进一步展示 active subscription 列表和 key 列表 |

## 不纳入当前范围

- 改造 new-api 源码或数据库 schema。
- 复制其他系统的管理后台。
- 把运营报表作为 P0 主链路。
- 自动跨 Set 搬迁已存在的 new-api 用户。
- 自动覆盖远端 channel drift。
