# LLMGateway Drop-in new-api 规格

## 1. 范围

LLMGateway MUST 作为多 Set new-api 的统一控制面和流量入口。它 SHOULD 对外提供稳定平台协议，对内调用 new-api 原生 API。

LLMGateway MUST NOT 修改 new-api 源码。LLMGateway SHOULD NOT 直接写 new-api 数据库，除非后续通过单独 proposal 明确批准。

## 2. Set 管理

### Requirement: 纳管已有 new-api Set

LLMGateway MUST 支持注册已有 new-api deployment，并保存 `set_id`、名称、base URL、状态、admin user id、admin access token。

#### Scenario: 注册 Set

- Given 运营人员提供 `set_id` 和 new-api base URL
- When 调用 `POST /api/sets`
- Then LLMGateway 保存 Set registry
- And 不主动修改远端 new-api

### Requirement: 初始化空 Set

LLMGateway MUST 能通过 new-api setup/login/token API 初始化空 Set root 管理员。

#### Scenario: Bootstrap

- Given Set 处于未初始化状态
- When 调用 `POST /api/sets/{set_id}/bootstrap`
- Then LLMGateway 调用 new-api `/api/setup`
- And 登录 root/admin 用户
- And 保存 admin access token 和 user id

### Requirement: 云原生 Set 自动纳管使用 facts 驱动

LLMGateway MUST 支持接收 kro、Job、CronJob 或发布流水线写入的 Set reconcile facts。写入 facts MUST NOT 直接注册或 bootstrap Set；facts 只表示外部控制面观测到某个 Set 应存在。LLMGateway-control MUST 能消费 `pending` facts，并复用 `RegisterSet` 与 `BootstrapSet` 完成最终 Set registry 收敛。

#### Scenario: kro 写入 Set facts

- Given kro 已经为 `fleet-demo` 展开 new-api Service
- When 调用 `POST /api/admin/set-reconcile-facts`
- Then LLMGateway 保存 `source/namespace/fleet/set_id/base_url/shard_ref`
- And 不写入 `llmgateway_sets`
- And 不调用远端 new-api

#### Scenario: control 消费 pending facts

- Given `llmgateway_set_reconcile_facts` 中存在 `status=pending` 的 Set
- When 调用 `POST /api/admin/set-reconcile-facts/reconcile`
- Then LLMGateway 注册 Set
- And 对空 Set 执行 bootstrap
- And 将 fact 状态更新为 `managed` 或 `error`

### Requirement: 根据用户水位扩 Set

LLMGateway SHOULD 根据 Set 的 user binding 数量维持 ready free users 水位。低于水位时，LLMGateway MUST 只写入 Set provision request，不直接创建 new-api runtime、不直接 patch LLMFleet。request MUST 按 `pending → created → configured → managed` 推进：`created` 表示仅 master Ready 且 slave 为 0；`configured` 表示 control 已完成 bootstrap 和配置预检；`managed` 表示 set-manager 已将 slave 扩到目标数且 Fleet Ready。ProvisionStatus MUST 与 AdmissionStatus 分离，只有 managed Set 才能通过最终 admission。扩容 MUST 只影响新用户分配；已有用户 MUST 留在原 Set，P0 MUST NOT 自动缩容。

单 Set 用户上限、水位目标和预留空位 MUST 可配置。`max_users_per_set` 表示一个 Set 的容量单位，`target_utilization` 表示期望使用率，`min_ready_free_users` 表示整个 Fleet 的最低空余用户位；管理台和 set-manager SHOULD 使用同一组字段调用 reconcile API。

Redis DB 分配 MUST 受 `redis_db_start` 和 `redis_db_limit` 约束，实际分配范围为 `[redis_db_start, redis_db_limit)`。LLMGateway MUST 跳过已有 provision request 占用的 Redis DB；当范围耗尽时 MUST 返回明确错误，而不是生成会导致 new-api 启动失败的 DB index。Redis DB 0 MUST 能被显式表达，因此只开放 DB 0 的云 Redis 代理可以配置 `redis_db_start=0, redis_db_limit=1`，不能依赖本地 16 DB 默认值。

#### Scenario: 低水位产生扩容请求

- Given `set-a` 已经 active/bootstrapped，且用户数接近 `max_users_per_set`
- And ready free users 低于 `min_ready_free_users`
- When 调用 `POST /api/admin/set-capacity/reconcile`
- Then LLMGateway 写入 `llmgateway_set_provision_requests`
- And 不写入 `llmgateway_sets`
- And 不调用目标 new-api
- And Redis DB 位于 `[redis_db_start, redis_db_limit)` 范围内

#### Scenario: 已有 pending 请求计入在途容量

- Given 已有 `status=pending`、`provisioning`、`created` 或 `configured` 的 Set provision request
- When 再次执行容量 reconcile
- Then LLMGateway 将该 request 计入 inflight capacity
- And 不重复创建同等容量的 request

#### Scenario: 新用户分配到低水位 Set

- Given 多个 active Set 都可用
- And `set-a` 已绑定用户多于 `set-b`
- When 新用户首次创建 binding
- Then LLMGateway 选择用户数更少的 `set-b`

## 3. 用户归属和租户映射

### Requirement: Tenant 主表是分流真源

LLMGateway MUST 使用 Tenant 主表记录用户处于 `pending` 或由 `new` Set 承载。assignment API MUST 作为开通写入口，并在写入时同步 Tenant 主表。未知用户 MUST 默认 `pending`。`backend=new` MUST 携带非空 `set_id`；`pending`、`disabled` 或 `deleted` Tenant MUST 拒绝 `/v1/*` 流量路由。

#### Scenario: 未迁移用户

- Given 用户没有 Tenant 记录
- When ctl 查询用户权益
- Then LLMGateway 返回明确的 pending 状态，不调用外部网关

#### Scenario: 已迁移用户

- Given 用户 Tenant 记录为 `backend=new,set_id=set-a`
- When ctl 开通订阅或 Agent 使用外部 key 调用模型
- Then 请求落到 `set-a`

#### Scenario: 非 active 租户

- Given 用户 Tenant 记录为 `status=disabled`
- When ctl 尝试续费、迁移、发 key 或 Agent 使用外部 key 调用模型
- Then LLMGateway 拒绝请求

### Requirement: 不把业务 user_id 直接写入 new-api username

LLMGateway MUST 维护外部业务 user_id 到 new-api username/upstream user id 的映射。new-api username 长度限制和字符规则不应泄漏给业务系统。

UserBinding MUST 显式保存 provisioning 状态：`allocated`、`user_ready`、`token_ready` 或 `failed`。失败状态 MUST 保存最近一次错误，供运营判断半纳管状态。

## 4. 订阅和权益

### Requirement: new-api 是 new 用户 LLM 权益真源

对于 `backend=new` 用户，LLMGateway MUST 使用目标 Set 的 new-api subscription 作为 LLM 权益和扣费真源。

托管 new-api Set MUST 配置 `GLOBAL_API_RATE_LIMIT_ENABLE=false` 和 `GLOBAL_WEB_RATE_LIMIT_ENABLE=false`。平台级准入、鉴权和运营限流 MUST 在 LLMGateway 或外层网关执行，不能依赖 new-api Set 内置全局 `/api` 限流，否则批量纳管、订阅发放、渠道同步和 BYOK 同步会被误伤。

LLMGateway MUST NOT 把 new-api 邀请码暴露为平台语义。由于 new-api 创建用户会内部生成短 `aff_code` 且该字段有唯一索引，LLMGateway MUST 对 `aff_code` 唯一键碰撞重试创建用户；用户名重复等真实唯一键冲突 MUST 直接失败。

LLMGateway MAY 保存 period overlay，用于 ctl 对 period_end 的观测和对齐，但 MUST NOT 保存完整余额账本。

### Requirement: 新购和续费

LLMGateway MUST 支持通过 new-api admin subscription API 给用户创建 subscription。续费 MAY 表达为新增一条 subscription，而不是更新原 subscription id。

#### Scenario: 续费

- Given 用户已有 active subscription
- When trade/ctl 要求续费同一 plan
- Then LLMGateway 在目标 Set 创建新的 user subscription
- And 对外 credit/period 视图仍体现用户可用权益

### Requirement: 取消

LLMGateway MUST 支持取消 new 用户 active subscription。取消 SHOULD 调用 new-api invalidate API，而不是硬删除。

### Requirement: 查询余额

LLMGateway MUST 为 ctl/trade 提供 `credit_available` 视图。已开通用户 SHOULD 聚合目标 Set active subscription 剩余额度；待开通用户 MUST 返回明确的 pending 错误。

## 5. API Key 和流量路由

### Requirement: 外部 key 由 LLMGateway 签发

LLMGateway MUST 签发平台外部 `sk-*` key，并保存到 upstream new-api token 的映射。

new-api upstream token SHOULD 使用 unlimited quota，避免 token quota 和 subscription quota 双重限制。

### Requirement: /v1/* 轻代理

LLMGateway MUST 只解析 Authorization header，找到 key binding 后替换为 upstream key 并反代目标 Set。LLMGateway MUST NOT 解析 OpenAI chat/completions payload 作为路由依据。

### Requirement: 未知 key 拒绝

LLMGateway MUST 只识别自身签发并写入路由快照的外部 key。未知 key MUST 返回 401，MUST NOT 转发到任何其他网关。

### Requirement: 用户级 BYOK 设置

LLMGateway MUST 支持保存用户级 LLM 设置，包括路由偏好和有序 BYOK provider 列表。路由偏好 v1 只支持 `byok_first` 和 `platform_first`，MUST NOT 暴露用户自定义权重算法。

保存设置 MUST 只写 LLMGateway 本地 desired state，MUST NOT 自动修改 new-api。同步设置 MUST 是显式动作。

流量代理 MUST 在不解析业务 payload 的前提下，根据用户 LLM 设置选择 upstream token：`byok_first` 且已同步 BYOK token 时使用 BYOK upstream token；否则使用平台 upstream token。LLMGateway v1 MUST NOT 在 BYOK token 和平台 token 之间做失败重试，避免流式响应和请求体重放带来不确定性。

BYOK 私有 group 的倍率 MUST 为 0。目标 Set 的基线配置 SHOULD 保持 free-model pre-consume 关闭；该基线不属于用户 BYOK API 的职责。

平台 upstream token MUST 固定写入 `default` group。BYOK upstream token MUST 固定写入用户私有 group；同步 BYOK 设置时，LLMGateway MUST 将目标 new-api 用户的 home group 设置为该私有 group，使 new-api 原生分组授权能够放行 BYOK token，同时仍允许平台 token 访问默认分组。

#### Scenario: 保存用户 BYOK 设置

- Given ctl 或用户设置服务提交用户自己的 provider key、base URL 和模型映射
- When 调用 `PUT /api/internal/users/{user_id}/llm-settings`
- Then LLMGateway 保存用户级 desired state
- And 响应不包含 provider key 明文
- And 不调用目标 new-api Set

#### Scenario: 同步用户 BYOK 设置到 new-api

- Given 用户已经绑定到 `backend=new,set_id=set-a`
- And 用户保存了 enabled BYOK provider
- When 调用 `POST /api/internal/users/{user_id}/llm-settings/sync`
- Then LLMGateway 在 `set-a` 确保用户私有 group 存在且倍率为 0
- And 按 provider 顺序创建或更新 new-api channel；由于 new-api 按 priority 降序选路，列表越靠前的 provider MUST 写入越大的 priority
- And 为该用户创建 unlimited quota 的 BYOK upstream token
- And 将目标 new-api 用户的 home group 更新为用户私有 group
- And 保存 remote channel id、BYOK group、BYOK upstream token id 和同步时间

#### Scenario: 默认平台 Key 优先

- Given 用户没有保存过 LLM 设置
- When 查询 `GET /api/internal/users/{user_id}/llm-settings`
- Then 返回 `routing.mode=platform_first`
- And `providers=[]`

## 6. Channel desired state

### Requirement: 本地 desired state

LLMGateway MUST 保存 channel desired state，并标记每个 Set 的 sync state。保存 desired state MUST NOT 自动写远端 new-api。

### Requirement: 手动同步

运营人员 MUST 能手动将 channel sync 到一个或全部 Set。同步成功后 MUST 保存 remote channel id、fingerprint、last_synced_at。

### Requirement: 漂移处理

LLMGateway MUST 支持 check-only drift 检查。发现 drift 时 MUST NOT 自动覆盖远端。只有显式 `force_drift=true` 才能覆盖远端。

## 7. 控制面边界

### Requirement: 仅管理 new-api Set

LLMGateway MUST 只处理本地租户和已纳管 new-api Set。任何控制面接口 MUST NOT 转发到其他网关；待开通租户由调用方通过显式 provisioning/migration API 激活。

## 8. 管理控制台

### Requirement: 管理台以 LLMGateway OpenAPI 为契约

管理台 MUST 消费 LLMGateway API，而不是直接消费 new-api 原生 API。嵌入 new-api 原生控制台只用于单 Set 深入排查，不作为平台稳定契约。

### Requirement: 租户管理

租户列表 MUST 以 LLMGateway Tenant 主表为库存，不逐个扇出请求所有 new-api Set。租户详情 MAY 按需实时读取目标 Set。

租户列表 SHOULD 展示最近一次 tenant observation projection。该 projection MUST 只作为运营缓存，不参与扣费和权益判断，也 MUST NOT 单独成为租户库存来源。

租户列表 MUST 支持 cursor pagination。cursor 排序键为 `updated_at DESC, user_id ASC`；传入 cursor 时 MUST 忽略 offset。旧 offset 参数 MAY 继续保留用于兼容。

#### Scenario: 刷新租户观测

- Given 租户已经绑定到 new-api Set
- When 运营人员调用 `POST /api/admin/users/{user_id}/observe`
- Then LLMGateway 读取该租户当前态
- And 保存最近一次 plan、subscription、credit、period 摘要
- And 后续租户列表可直接展示该投影

#### Scenario: Cursor 翻页

- Given 租户列表第一页返回 `has_more=true`
- When 调用方把响应里的 `next_cursor` 作为下一次请求的 `cursor`
- Then LLMGateway 返回排序键之后的下一页租户
- And 不使用 offset 扫描大页码

### Requirement: 受控数据库视图

管理台 MUST 能查看 LLMGateway 自有状态表，但 MUST NOT 暴露任意 SQL 或任意表操作。

LLMGateway MUST 提供固定资源白名单，并在资源定义中返回列、主键、可编辑性、敏感字段和 action。密钥类字段 MUST 脱敏返回。PATCH MUST 只允许修改资源定义中 `editable=true` 的字段。状态切换、路由切换、bootstrap、clear provisioning error 等领域行为 MUST 通过显式 action 完成。

#### Scenario: 字段脱敏

- Given 运营人员读取 `sets` 或 `api_key_bindings`
- When 资源行包含 admin token 或 upstream key
- Then 响应只返回脱敏值
- And 不返回密钥明文

#### Scenario: 拒绝绕过领域 action 的 PATCH

- Given 一个 Tenant 当前为 `backend=pending`
- When 运营人员 PATCH `backend=new,set_id=set-a`
- Then LLMGateway 拒绝该 PATCH
- And 要求调用 `POST /api/admin/resources/tenants/actions/route_new`

## 9. 可观测性和测试

### Requirement: 请求级观测

流量代理 SHOULD 记录结构化 access log，至少包含 external key id 或 hash prefix、set id、upstream status、duration、streaming、error type。

LLMGateway SHOULD 在 `/metrics` 暴露 Prometheus 文本指标，至少包含请求计数和 duration ms sum/count，并使用与 access log 对齐的 routing/result 标签。

### Requirement: 可复现测试

LLMGateway MUST 维护 Compose E2E，覆盖两个 new-api Set、MySQL/Redis、provisioning、subscription、key routing、channel bundle option + channel sync，以及基于本地 `mockllm` 的 OpenAI-compatible chat probe。真实外部模型调用 probe SHOULD 作为可选增强，不得成为默认可复现测试的前置条件。

### Requirement: 配置包同步顺序

Channel bundle MUST 同时表达平台 channel desired state 和 new-api 系统 option desired state。LLMGateway apply 配置包时 MUST 先同步 `ModelRatio`、`CompletionRatio` 等 option，再创建或更新 channel，避免渠道已经可路由但模型价格尚未配置。新 Set 自动纳管完成后，LLMGateway MUST 将所有已有配置包同步到该 Set。
