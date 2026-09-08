# Credit Agent Guide

`credit` 是 LightVela 独立积分服务。当前实现付费积分包；免费积分和套餐积分的入口迁移后续再补。

## 服务边界

- `credit` 持有积分商品、live 积分包、历史积分包和每日用量真源。
- 用户通过 `credit` 发起询价、下单、下单并支付、退款和查询，不提供续费能力。
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
- `POST /v1/credit/packages/order-and-pay`
- `GET /v1/credit/packages?user_id=...`
- `POST /v1/credit/packages/{package_id}/refund`

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

- 独立进程：`credit-lifecycle-worker`；北京 7 部署两个 Pod。
- 默认每 10 秒扫描一次，每批最多 50 个 package，抢占 lease 为 30 秒。
- 可通过 `CREDIT_LIFECYCLE_WORKER_POLL_INTERVAL`、`CREDIT_LIFECYCLE_WORKER_BATCH_SIZE`、
  `CREDIT_LIFECYCLE_WORKER_LEASE_DURATION` 调整。
- 多 Pod 对同一 package 只有 CAS 抢占成功者执行销毁；普通失败恢复 `active`，进程异常由 stale
  `terminating` 路径恢复。

## 发布与命令

source-facing 位于 `credit/k8s/base/`，deploy-facing 位于 `argocd/services/credit/<env>/`。当前仅北京 7 部署 `credit-usage-worker` 和 `credit-lifecycle-worker`；其它环境待北京 7 验证后再接线。

各环境的 `credit-platform.env` 必须提供 `CREDIT_REGION` 和 `CREDIT_OBJECT_ID_PASSWORD_SUFFIX`，并由公共 Kustomize component 注入运行时 `credit-config`；Credit API 启动时会校验这两个资源 ID 生成参数。

```bash
cd credit && env GOCACHE=/tmp/codex-go-cache go test ./...
python3 .ci/runtime/commands/build_release_image.py --service credit --env <env> --tag <tag>
credit-migrate
```

不要把 migration 塞回应用启动路径，不要在仓库写入任何 secret，`generated/` 不提交。
