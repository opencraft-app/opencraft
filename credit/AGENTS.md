# Credit Agent Guide

`credit` 是 LightVela 独立积分服务。当前实现付费积分包；免费积分和套餐积分的入口迁移后续再补。

## 服务边界

- `credit` 持有积分商品、live 积分包、历史积分包和每日用量真源。
- 用户通过 `credit` 发起询价、下单、获取支付链接、退款和查询，不提供续费能力。
- 控制台购买固定使用“下单 -> 获取支付链接”两段式链路；下单成功时签发绑定用户和订单的短期一次性 `auth_code`，供无主站 session 的支付中转页获取链接；`order-and-pay` 仅供内部联调和自动化测试，不能作为真实用户购买入口。
- `trade` 持有订单、jifei 回调和 qbilling 协议适配；`credit` 不拼计费协议。
- 积分额度由 `llm_gateway_plan_id` 对应的 LLMGateway plan 决定，底层 plan 使用长期有效期。
- `credit_package.expired_time` 来自真实资源包周期，资源包到期生命周期由 Credit 自主管理；计费不会在自然到期时回调隔离。

## 数据模型

### `credit_product`

- `product_id`: 与 `trade_credit_definition.product_id` 弱关联。
- `product_name`: 商品展示名。
- `llm_gateway_plan_id`: LLMGateway plan ID，也是额度配置真源。
- `state`: `online/offline`。

不要新增 `token_total`、`price_cent`、`sales_state`、`time_span` 或 `time_unit`。

### `credit_package`

- `package_id`: `cpkg-xxxxxxxx` 格式的资源 ID。按 `deal_name` 在
  `credit_package_id_allocation` 中幂等分配自增序号，再使用与 pass 相同的编码算法、
  `creditmon + CREDIT_OBJECT_ID_PASSWORD_SUFFIX` 密码及 `CREDIT_REGION` 生成。
- `user_id`: LightVela 用户 ID。
- `uin`: string 类型；`app_id`: int64 类型。
- `product_id`, `deal_name`, `big_order_id`: 商品与创建订单标识。
- `llm_gateway_plan_id`, `llm_subscription_id`, `llm_subscription_name`: 底层订阅快照。
- `expired_time`: 顶层资源包到期时间。
- `status`: 正常状态为 `active`；生命周期 worker 抢占处理时短暂进入 `terminating`。

自然到期或计费隔离完成后立即销毁：物理删除 live 行并插入 `history_credit_package`，不保留
`isolated` live 行。历史兼容数据中的 `isolated` 允许被直接归档；不要使用 `deleted` 作为 live 状态。

### 用量表

- `credit_package_usage`: 每个 live package 最多一行，既是滚动累计快照也是 `sendResource` outbox。
- `history_credit_package_usage`: 自然到期或计费隔离销毁时与 package 在同一事务中从 live 表迁入，永不参与推量。
- 积分字段使用 `DECIMAL(24,4)`；Go 使用定点 `CreditAmount`，禁止用浮点计算。
- `next_retry_time` 是唯一调度条件；查询条件为 `next_retry_time <= now AND package_expired_time > now`。
- `push_status` 为 `init/pending/success/failed`，只表达执行状态和 CAS 抢占，不参与到期扫描。
- worker 抢占时按 `id + 原 next_retry_time` CAS 更新为 `pending` 并写 `lease_owner`；更新 0 行立即放弃。
- 成功后 `next_retry_time` 更新为下一个北京时间 0 点；失败按退避时间更新。
- 重试复用冻结的 `request_payload`，避免同一业务日重复计算产生不同数据。

新购时随 `credit_package` 原子插入用量行，首次上报时间为下一个北京时间 0 点。migration 为存量 active package 插入零值行，worker 首次仅建立累计基线，不推送历史累计量。

## Trade 商品与订单

`trade_credit_definition` 保存 `product_id` 到 `product_code/sub_product_code/pid/sv_*/category_ids` 的映射。`category_ids` 沿用 pass 的 key:value 场景映射语义。

`lightvela.credit.checkCreate` 必须按 `productId` 读取该定义，并精确校验回调
`goodsDetail` 中的 `pid` 以及全部 `sv_*` 字段和值；缺失、多传或不一致时必须拒绝下单，
不能只校验字段存在性。`goodsCategoryId` 不在 checkCreate 回调的 `goodsDetail` 中；询价、
下单和下单并支付时必须从 `category_ids[scene=purchase]` 取值并写入出站
`goods[n].goodsCategoryId`。

询价和下单的 `goodsDetail`：

- `timeSpan=1`, `timeUnit=p` 表示资源包计费模式。
- `packageTimeSpan/packageTimeUnit` 携带真实资源包时长。
- `trade_order.period/time_unit` 保存真实资源包时长。

## API

用户入口：

- `GET /v1/credit/products`
- `POST /v1/credit/inquiry`
- `POST /v1/credit/packages/order`
- `POST /v1/credit/packages/order-url`
- `POST /v1/credit/packages/order-and-pay`
- `GET /v1/credit/packages`
- `POST /v1/credit/packages/{package_id}/refund`

`order` 返回 Trade 的 `bigOrderId/dealName` 和 `auth_code`。ticket 由 Credit 自己的 Redis store
保存，绑定 `user_id + deal_name`，默认 10 分钟过期；消费使用 Lua `GET + DEL` 保证多 Pod 下
严格一次性。签发失败不回滚已经创建的 Trade 订单，返回空 `auth_code`，登录态链路仍可继续。

`order-url` 支持登录态和 ticket 两种鉴权。请求携带 `auth_code` 时必须优先原子消费 ticket，
按 ticket 恢复原下单用户并校验绑定的 `deal_name`；只有缺少 `auth_code` 时才回退到可信
`X-User-Id`。ticket 无效、过期或重放不得回退登录态并返回 401，订单不匹配返回 403。
解析出用户后，Credit 要求 Trade 同时校验 `external_user_id` 和
`resource_type=credit_package`；订单不存在、归属不符或资源类型不匹配统一按 404 处理。

查询结果只返回 `credit_type/credit_total/credit_available/expired_time`。`credit_type` 按 LLMGateway subscription name 判断：`credit-package:` 为 `paid`，`free-credit:` 为 `free`。isolated 或已到期积分包不返回。

trade 调 credit：

- `POST /internal/credit/packages/complete`
- `POST /internal/credit/packages/used-amount`
- `POST /internal/credit/packages/app-ids`
- `POST /internal/credit/packages/by-owner`
- `POST /internal/credit/packages/query-resources`
- `POST /internal/credit/packages/{package_id}/isolate`

credit worker 调 trade：

- `POST /internal/trade/credit/resources/usage/report`

## 计费回调

trade 的 `/trade/jifei/callback` 分发：

- `lightvela.credit.checkCreate`
- `lightvela.credit.createResource`
- `lightvela.credit.getAllAppIds`
- `lightvela.credit.getUserResources`
- `lightvela.credit.queryResource`
- `lightvela.credit.getUsedAmount`
- `lightvela.credit.isolateResource`

不注册 credit 的 `checkRenew/renewResource/resetResourceExpire/queryFlow/destroyResource`。

资源中心反查与 pass 保持同一套三接口语义：`getAllAppIds` 按计费商品定义和分页返回 live package
的去重 app_id；`getUserResources` 按 `(uin, appId)` 分页返回 live package；`queryResource`
按 `(appId, resourceIds[])` 精确反查。自然到期或隔离完成的 package 已移入历史表，不参与反查。
`getUserResources` 和 `queryResource` 返回的每个资源必须携带 `instanceType=6`，标识一次性
购买的资源包；Pass 资源仍使用普通类型 `instanceType=0`。

`getUsedAmount` 查询 active、未到期且底层订阅仍存在的资源包，按已使用积分比例返回 `0..1` 小数。响应中的 `timeSpan/timeUnit` 来自创建订单的真实周期。已到期或已销毁时直接失败，不使用历史快照兜底。

create/isolate 使用 `trade_flow` 的 `create_resource/isolate_resource` 做幂等。隔离是同步回调，不返回 `flowId`；Credit 不接收 `destroyResource`。

## 生命周期

### 新购

1. credit 调 trade 询价或下单。
2. 支付成功后计费回调 `createResource`。
3. trade 抢占 flow slot，并调 credit complete。
4. credit 创建非唯一的 `credit-package:{package_id}` LLMGateway subscription。
5. ApplySubscription 的响应可能是订阅集合视角；credit 必须再次查询 active subscriptions，
   按完整 subscription name 精确匹配本次订阅，并以匹配项的 ID、额度和余额初始化数据。
6. 精确订阅不存在时不写 package/usage，等待同一 deal 幂等重试；匹配成功后原子写入
   package 和首条 usage 行。

### 自然到期

- 独立 `credit-lifecycle-worker` 扫描 `expired_time <= now` 的 active package。
- worker 使用 `active -> terminating` 条件更新抢占；`terminating` 只表示正在处理，不是失败终态。
- 抢占后删除该 package 的精确 LLMGateway subscription，再在同一事务中把 package 和 usage
  分别迁入历史表并删除 live 数据。
- 自然到期历史记录使用 `destroy_reason=expired`、`archive_reason=expired`，`isolated_time` 为空。
- 删除订阅或归档失败时，通过本次抢占时间 CAS 恢复为 `active`，下一轮重新处理。
- Pod 在恢复前退出时，超过 lease 的 `terminating` 可被其他 Pod 重新抢占。
- 到期后不再调用 `sendResource`，不补推到期前最后一段用量。

### 计费隔离

- 用户退款由 Credit 调 Trade 的 `OnlineRefund`，后续计费只回调 `isolateResource`。
- `isolateResource` 删除精确 LLMGateway subscription 后立即迁移 package/usage 历史并删除 live
  数据，不进入或保留 `isolated` 状态，也不等待 `destroyResource`。
- 隔离历史记录写入当前 `isolated_time`，并将计费传入的 `reason` 同时保存为 package
  `destroy_reason` 和 usage `archive_reason`；reason 为空时使用 `billing_isolate`。
- 重复删除订阅、重复隔离和重复历史迁移均按幂等成功处理。

## 每日推量

- 独立进程：`credit-usage-worker`，允许多 Pod 并发。
- credit 查询精确订阅并按 `CREDIT_TOKEN_RATIO` 把 token 换算为四位小数积分。
- 普通零用量也必须调用 `sendResource`；到期后不再推送。
- trade 从 `trade_credit_definition` 读取商品字段，统一按 `units.credit=1` 调 qbilling。
- `serialId=package_id`, `orderId=deal_name`, `cid=101433`；计费 duplicate 计为成功。
- 业务日期按 `Asia/Shanghai` 自然日，数据库时间统一 UTC。

## 生命周期 Worker

- 独立进程：`credit-lifecycle-worker`；北京 7 和 `beijing-sandbox` 均部署两个 Pod。
- 默认每 10 秒扫描一次，每批最多 50 个 package，抢占 lease 为 30 秒。
- 可通过 `CREDIT_LIFECYCLE_WORKER_POLL_INTERVAL`、`CREDIT_LIFECYCLE_WORKER_BATCH_SIZE`、
  `CREDIT_LIFECYCLE_WORKER_LEASE_DURATION` 调整。
- 多 Pod 对同一 package 只有 CAS 抢占成功者执行销毁；普通失败恢复 `active`，进程异常由 stale
  `terminating` 路径恢复。

## 发布与命令

source-facing 位于 `credit/k8s/base/`，deploy-facing 位于 `argocd/services/credit/<env>/`。北京 7
用于回归验证；`master` 为 `beijing-sandbox` 构建镜像并自动创建 GitOps pin，API、
`credit-usage-worker` 和 `credit-lifecycle-worker` 一并发布。东京由专用 CI 构建并自动 pin 到
`sandbox-jp-1`；上海和新加坡随 master 构建镜像，但都必须人工 promote 后才能发布。

`beijing-sandbox` 使用共享 CynosDB 中独立的 `credit` 库/用户；运行时 Secret 长期真源为
SSM `mono-beijing-sandbox-credit-runtime-secrets`，通过
`scripts/ssm_manifest.credit.beijing-sandbox.yaml` 导出 SOPS。禁止复用北京 7 的数据库密码。

北京测试环境首次初始化积分包商品时，先执行 `trade-migrate`，再分别使用对应数据库账号执行
`scripts/seed_trade_beijing_sandbox_credit_definitions.sql` 和
`scripts/seed_credit_beijing_sandbox_products.sql`。两份 seed 均可幂等重跑；Credit 商品复用北京 7
已经创建在同一 LLMGateway 控制面的五个 plan。

各环境的 `credit-platform.env` 必须提供 `CREDIT_REGION` 和 `CREDIT_OBJECT_ID_PASSWORD_SUFFIX`，并由公共 Kustomize component 注入运行时 `credit-config`；Credit API 启动时会校验这两个资源 ID 生成参数。

Credit API 还需要 `CREDIT_REDIS_ADDR`、`CREDIT_REDIS_PASSWORD`、`CREDIT_REDIS_DB` 和
`CREDIT_AUTH_CODE_TTL` 初始化一次性支付 ticket store；默认 DB 为 0、TTL 为 10 分钟。Redis
只属于 API 支付链路，usage/lifecycle worker 不校验也不连接 Redis。Service Gateway 只对
`POST /v1/credit/packages/order-url` 配置 `optional_auth_allow`，其他 Credit 路由仍要求 session。

```bash
cd credit && env GOCACHE=/tmp/codex-go-cache go test ./...
python3 .ci/runtime/commands/build_release_image.py --service credit --env <env> --tag <tag>
credit-migrate
```

不要把 migration 塞回应用启动路径，不要在仓库写入任何 secret，`generated/` 不提交。
