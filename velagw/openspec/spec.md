# 当前技术规格

LLMGateway 的当前规格是：在不修改 new-api 的前提下，把多个 new-api Set 封装成可被 `ctl`、`trade`、运营控制台和 Agent 客户端使用的多 Set LLM 网关。

## 目标

1. 对 `ctl/trade` 提供稳定的订阅、权益和密钥接口。
2. 对 Agent 客户端表现为 OpenAI-compatible `/v1/*` endpoint。
3. 对运营人员表现为统一管理台，可纳管 Set、租户、Plan、Key 和 Channel。
4. 对 new-api 表现为普通 admin/API 调用者，不要求 new-api 感知多租户平台层。

## 稳定契约

| 契约 | 要求 |
| --- | --- |
| 用户归属 | Tenant 主表记录 pending/new 开通状态；assignment API 是开通写入口，未知用户默认 pending |
| Set 选择 | 新用户首次绑定时分配 Set；后续请求必须使用绑定 Set |
| 权益发放 | new 用户权益通过目标 Set 的 new-api subscription admin API 发放 |
| 余额查询 | 已开通用户从目标 Set active subscription 聚合；pending 用户返回明确错误 |
| 租户观测 | 列表以 Tenant 主表为库存，展示本地 observation projection；刷新观测必须显式调用，不自动扇出所有 Set |
| 租户分页 | `GET /api/admin/tenants` 使用不透明 cursor；库存按 `updated_at DESC, user_id DESC`，搜索按 user ID/内部账号前缀两阶段分页；默认不计算精确总数 |
| 租户统计 | worker 定期生成租户数量快照；`GET /api/admin/tenant-statistics` 只读快照，不在请求中扫描租户表 |
| 后台任务 | 运营总览不包含任务；独立 `GET /api/admin/background-jobs` 聚合任务和异步队列 |
| 外部 key | LLMGateway 生成外部 `sk-*` key，并映射到 upstream new-api token |
| 流量代理 | `/v1/*` 只替换 Authorization；按用户 LLM 设置选择 platform 或 BYOK upstream token，不解析业务 payload |
| 未知 key | 返回 401，不转发到任何其他网关 |
| 云原生 Set 纳管 | kro/Job 只写 Set reconcile facts；llmgateway-control 消费 pending facts 后执行注册和 bootstrap |
| Set 容量水位 | 根据 user binding 数量维持 ready free users；低水位时只生成 Set provision request，不搬迁已有用户 |
| channel sync | 保存 desired state 不写远端；手动 sync/check drift；显式 force 才覆盖 |
| 用户 BYOK | 用户级 LLM 设置先保存本地 desired state；显式 sync 后才写入目标 Set 的私有 group/channel/token |
| 可观测性 | 记录 external key、set、upstream status、duration、streaming、error type |

## new-api 执行面映射

| LLMGateway 诉求 | new-api 能力 | 适配方式 |
| --- | --- | --- |
| 空 Set 初始化 | `/api/setup`、`/api/user/login`、`/api/user/token` | bootstrap 保存 admin user id 和 access token |
| 创建上游用户 | `/api/user/` | 用户名使用 LLMGateway 生成的短映射，不直接放业务 UUID |
| 发放 API token | `/api/token/`、`/api/token/{id}/key` | upstream token 建议 unlimited quota |
| 创建套餐 | `/api/subscription/admin/plans` | worker 将不可变权益模板下发到每个 active Set，并记录独立的 upstream plan id |
| 发放订阅 | `/api/subscription/admin/users/{id}/subscriptions` | 续费可新增一条 subscription |
| 取消订阅 | `/api/subscription/admin/user_subscriptions/{id}/invalidate` | LLMGateway 可按用户聚合后定位 active sub |
| 管理渠道 | `/api/channel/*` | LLMGateway desired state 同步到每 Set |
| 用户 BYOK provider | `/api/option/`、`/api/channel/*`、`/api/token/*` | LLMGateway 为用户创建私有 group，provider 顺序映射为 channel priority，BYOK token 使用 unlimited quota |
| 日志统计 | `/api/log/*`、`/api/data/*` | P0 不做全量报表；后续按 Set 聚合 |

## 数据持久化原则

LLMGateway MySQL 只保存平台层状态：

- Set registry；
- Set reconcile facts；
- Set provision requests；
- User binding；
- API key binding；
- Plan mapping；
- Tenant 主表；
- User assignment 兼容记录；
- Period overlay；
- Channel desired state；
- Channel sync state；
- User LLM settings desired state；
- Tenant observation projection；
- Tenant statistics snapshot；
- 不可变权益模板及每 Set 下发状态；
- Worker job、lease 和 run。

Tenant observation projection 只保存最近一次运营观测到的 plan、subscription、credit 和 period 摘要。它是缓存和展示投影，不参与扣费。

订阅权益只使用 `llmgateway_plans` 和 `llmgateway_set_plans` 两张表。Plan ID 表达一份不可变权益定义；同 ID 同内容可幂等写入，同 ID 不同内容必须冲突。worker 负责下发到 active Set，新 Set 纳管时必须补齐全部 active Plan；用户准入只选择对应下发状态为 `ready` 的 Set。

Set reconcile facts 是云原生路径的纳管触发事实表，只表达“某个 Fleet 观测到某个 Set 应存在”。写入 facts 不会直接注册或初始化 Set；llmgateway-control 消费 `pending` facts 后，才会复用 `RegisterSet` 和 `BootstrapSet` 完成最终 Set registry 收敛。

Set provision requests 是容量控制器产生的扩 Set 意图。LLMGateway 根据 active/ready Set 的用户绑定数、单 Set 最大用户数、目标水位和 open request 计算缺口；低水位时写入 `pending` request，由 set-manager 创建 runtime。扩容只影响新用户分配，已有用户不自动搬迁；P0 不自动缩容。

Channel bundle 是跨 Set 一致性的配置包。它同时保存 new-api 系统 option（例如 `ModelRatio`、`CompletionRatio`）和平台 channel desired state；apply 到 Set 时必须先同步 option，再创建或更新 channel，避免渠道已出现但模型仍未配置价格。新 Set 被自动纳管后，control-plane 必须把所有已存在的配置包同步到该 Set。

LLMGateway 不保存完整 LLM 扣费账本。已开通用户的 LLM 权益、扣费、日志仍以目标 new-api Set 为真源。

托管的 new-api Set 必须关闭内置全局 API/Web 限流：`GLOBAL_API_RATE_LIMIT_ENABLE=false`、`GLOBAL_WEB_RATE_LIMIT_ENABLE=false`。LLMGateway 负责外层准入、鉴权和运营限流；new-api Set 内部的全局 `/api` 限流会误伤批量纳管、订阅发放、渠道同步和 BYOK 同步。

LLMGateway 平台语义不使用 new-api 邀请码。new-api 创建用户时仍会内部生成短 `aff_code`，LLMGateway 必须把 `aff_code` 唯一键碰撞视为可恢复上游副作用并重试创建用户；用户名重复等真实冲突不得被重试掩盖。

User LLM settings 保存用户自己的 BYOK provider、模型映射和路由偏好。保存设置只写 LLMGateway MySQL；同步设置才会调用目标 Set 的 new-api API。密钥明文只用于写远端和本地加密/哈希保存语义，HTTP 响应只返回 `key_hash`，不回显 `api_key`。BYOK 私有 group 倍率固定为 0，目标 Set 基线应保持 free-model pre-consume 关闭。同步 BYOK 时，LLMGateway 会把 new-api 用户 home group 设置为该用户私有 group；平台 upstream token 固定写入 `default` group，BYOK upstream token 固定写入私有 group，从而让 `platform_first` 和 `byok_first` 在同一个用户下可稳定切换。流量面使用 30 秒本地 TTL 缓存读取用户 LLM 设置；同进程保存或同步设置会主动失效缓存，多 pod 场景依赖 TTL 最终一致。

## 验证要求

- 单元测试必须覆盖 provisioning、subscription facade、credit facade、key routing、channel sync。
- HTTP 测试必须覆盖管理台接口的 auth、响应 shape 和错误路径。
- Compose E2E 必须覆盖两个 new-api Set、MySQL/Redis、provisioning、channel bundle option + channel sync，以及基于本地 `mockllm` 的 `/v1/chat/completions` 非流式和流式 probe；真实外部 provider probe 仅作为可选增强。
- OpenAPI 契约测试必须保证 docs-site 暴露的接口与管理台消费面一致，并用 `openspec/openapi_contract.json` 和 `docs/openapi.json` 做 paths 双向校验。
