# Journey：订阅购买与续费

## 目标

用户选择套餐、完成支付并获得对应权益；续费、重复回调和中途失败不产生重复订单、重复权益或未付费开通。

## 链路

1. `frontend` 展示 `subscription` 返回的套餐/当前权益并发起购买或续费。
2. 公共请求经 `service-gateway` 到 `trade`/`payment`。
3. `trade` 创建订单并通过 provider 或 `cloudladdergateway` 调用外部计费。
4. `payment` 处理支付侧 contract/回调，使用稳定外部标识保证幂等。
5. `subscription` 应用支付结果并更新订阅、Pass 和配额。
6. 需要实例/能力开通时，只有 contract 成功后才调用 `ctl`。

## 失败与补偿

- 支付页面创建失败：不得提前应用权益。
- 回调重复/乱序：按外部订单标识幂等处理。
- 权益应用失败：保留可重试状态，不重复创建外部订单。
- CTL 开通失败：订单/支付事实不可丢失，补偿与重试单独记录。

## 国内站 Pass 续费点石

- 点石活动配置和参与资格按 `purchase`、`renew` 场景隔离；存量配置与参与记录迁移为
  `purchase`。控制台续费只消费 `renew` 资格，因此同一用户可分别参与一次新购活动和一次续费活动，
  但不得在同一活动场景重复享受优惠。
- 国内站续费询价和普通续费下单向点石传递的 `preference_param` 固定为 `regionId`、
  `resourceId`、`timeSpanUnit`、`bundleId`。首次符合续费活动的用户使用点石询价和 `do_goods`；
  已参与用户或询价活动解析失败时回退原计费续费链路。国际站保持原计费续费逻辑。
- 续费联调期间，点石续费询价、普通续费下单及内部续费下单显式发送 `preview=1`；新购请求不设置
  请求级 preview，继续沿用既有 `DIANSHI_PREVIEW` 客户端配置。请求级设置只能开启 preview，不能关闭
  客户端级开关，避免改变已有新购环境行为。
- 自动化续费折扣使用 Trade 专属内部接口
  `POST /internal/trade/dianshi/orders/renew/place-and-pay` 调用点石 `do_goods_and_pay`。该入口不读取或写入
  控制台参与资格，可重复调用，但只允许国内站和已登记的续费活动 Bundle。原计费内部续费接口
  `POST /internal/trade/orders/renew/place-and-pay` 保持不变。
- 点石同步回调可能早于本地续费订单写入；续费资源回调必须仅依赖稳定资源和外部订单事实完成幂等处理，
  不能假设 `trade_order` 已经存在。Trade 在点石调用成功后仍须原子写入本地续费订单和 `renew` 参与记录。

## Pass 升配 Web checkout

- 账号页和定价页仅对后端返回的合法 Bundle 关系展示升级入口与选择联动；展示资格不能代替 CTL 下单前的 owner、Pass 状态和目标校验。
- 可升级目标使用原有主按钮高亮，不套用新购席位已满的灰色样式。账号页与定价页不提供独立进度按钮，也不自动弹出未支付订单；用户主动点击升级只展示最新差价，明确确认支付后才新建订单。关闭后再次进入不恢复历史订单或二维码。
- Web 升配入口由 `frontend/src/lib/pass-upgrade-rollout.ts` 集中控制：国内正式站默认隐藏，任意登录用户可在浏览器 Console 执行 `show()` 临时显示，`hide()` 隐藏，刷新后重置；国际正式站关闭，明确列出的本地与北京前端测试域名允许登录用户验证。账号页、定价页、订单恢复与升级弹窗共用该判断；这是 UI 发布开关，不替代后端授权。正式验收通过后再独立调整默认开放范围。
- `GET /v1/passes/{pass_id}/modify/bundles` 返回实时差价；`POST .../modify/order` 只创建订单并返回 `deal_name`、`big_order_id` 和可选支付票据。
- `POST .../modify/order-url` 接收原 `deal_names` 获取支付链接，不再创建订单。微信桥使用绑定用户、Pass、订单的短期票据；`POST .../modify/payment-authorization` 仅供已登录本人重签原订单票据。
- `GET .../modify/checkout` 保留为兼容的只读接口，当前 Web 资格检查与建单流程不依赖它。历史未付款订单不阻塞新的明确确认；同次提交结果未知时仍保留本地保护，不能把请求超时当作未建单并自动重下。
- 对齐新购两步式流程：客户端防连点，每次明确确认支付请求新建订单，不承诺跨设备并发建单 exactly-once。升级交付仍使用现有 Pass slot/CAS 与 flow 幂等，不新增数据库锁或迁移；不同订单的回调不得重复应用同一次升级权益。
- 支付接口只允许 `pending_pay` 的 modify 单，并验证用户、资源、订单类型和合法目标；不复用新购/续费的 deal-only 支付链接缓存。国际站使用 hosted payment，国内站使用微信桥接。
- 订单状态反查只有在计费明确返回 `canceled`、`overdue` 或 `delete` 时才把本地 modify 单推进到 `cancelled`。`getDealsByKeyIndex` 的空结果可能是新订单的短暂可见性延迟，必须保留本地 `pending_pay` 并继续轮询，不能据此关闭支付窗口或永久取消订单。
- 成功条件为同一 modify 订单 `local_status=provisioned`、统一状态 `success`，并且该用户的同一 Pass 已成为目标 Bundle 且 `status=active`。收到付款状态不是升级完成。
- 本次确认建单成功后，国内支付弹窗展示微信二维码，不展示继续支付、微信内支付链接或手动刷新升级结果。同一弹窗内二维码过期仅重签当前订单票据；获取失败按轮询节奏重试，不新建订单。订单与 Pass 每 3 秒自动核对，超过 10 分钟仍继续等待交付，完成、失败或关闭弹窗后停止轮询。

## Credit 积分包 Web checkout

- 积分包询价与 Pass 使用相同的前端金额契约：`price`、`total_cost` 和 `real_total_cost` 均以分/美分返回。
  国际站 Trade 必须优先读取计费 `highPrecisionPrice.*High`（主币种 `×1e8`），在后端精确换算为美分，
  `real_total_cost` 同时按计费税率换算为含税美分；前端统一除以 `100` 展示，不能直接消费高精度原值。
- 控制台购买积分包使用两段式订单链路：`POST /v1/credit/packages/order` 只创建订单并返回
  `dealName` 和绑定用户、订单的 10 分钟一次性 `auth_code`，随后调用
  `POST /v1/credit/packages/order-url` 获取支付信息；
  `order-and-pay` 仅供内部联调和自动化测试，不能作为真实用户入口。
- 支付中转页没有主站会话时，通过 service-gateway 对该精确路由的匿名放行，把 `auth_code` 交给
  Credit 原子消费并恢复用户身份；票据使用 Redis Lua `GET + DEL` 保证多 Pod 下只能消费一次，
  且必须绑定请求中的 `deal_name`。请求携带 `auth_code` 时优先使用票据用户，即使网关同时注入
  `X-User-Id` 也不能覆盖；只有未携带票据时才使用登录用户。无效、过期或重放票据不得回退登录态。
- Credit 调用 Trade 获取支付链接时同时绑定用户和 `resource_type=credit_package`。订单不存在、订单
  不属于当前用户或不是积分包订单时统一返回不存在，不能暴露其他用户或其他资源类型的支付链接缓存。
- `need_charge=1` 时前端跳转 `pay_url`；`need_charge=0` 时直接进入支付完成后的刷新流程。支付完成
  不等于资源已创建，前端须重新调用 `GET /v1/credit/packages` 观察积分包出现，并兼容计费回调与
  LLMGateway 订阅创建的短暂延迟。

## 邀请返利首次开通链路

1. 前端先通过公开的隐私安全接口校验返利码。未登录用户由 Auth 写入 30 分钟 HttpOnly 上下文；已登录
   用户用当前 session 立即认领。
2. Auth 在真正创建新用户时写 `user.registered.v1`，存量但尚未首次开通的用户写幂等
   `user.referral_claimed.v1`。认领必须发生在首次开通之前；已开通或续费用户事后打开链接不产生奖励。
3. CTL 对启用环境中 dianshi 订单完成发货的新 Pass 或存量免费 Pass 转订单开通写 `pass.first_paid.v1`，
   0 元订单也符合，不检查实付金额。事件名为兼容旧消费者保留，续费及无订单免费试用不重复触发。
4. Referral 将注册、首付和退款分别持久化，两个事实齐备时在活动预算与邀请人上限内创建两侧奖励。
5. 默认不等待观察期；worker 在下一轮处理时调用 CTL 幂等送积分，VelaGW 按额度自动准备内部权益模板。
   CTL 发放前再次验证资格 Pass 和受益人 active Pass，无有效 Pass 时保留待发重试。
6. `pass.refunded.v1` 可早于或晚于首付事件到达，并只取消同一资格 Pass 尚未发放的奖励。

成功不能只看邀请码已创建或首付事件已消费，必须同时核对 attribution、资格 Pass、两侧 reward、
LLMGateway named subscription 和最终统计。没有 active Pass 的邀请人是可重试 pending，不是奖励丢失。

## 验证

成对验证订单、支付、订阅和 CTL 各阶段的成功/失败记录；线上金额、活动、API 地址和签名规则必须从登记的外部 authority 现场确认。
