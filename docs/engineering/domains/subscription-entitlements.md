# 订阅与权益领域

本领域覆盖套餐、订阅、Pass、配额、订单、支付、续费与外部计费。它由多个服务分阶段拥有，不能用一个前端字段或单张订单表代表完整状态。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `subscription` | 套餐、当前订阅、续费和权益应用 |
| `payment` | 支付链接/回调 contract 与支付侧幂等 |
| `trade` | 订单、计费 provider 和成功后的开通编排 |
| `credit` | 付费积分商品、积分包生命周期、精确积分用量与每日推量 |
| `referral` | 邀请返利活动、注册归因、首付/退款事实、观察期与奖励发放 |
| `cloudladdergateway` | 到 IDC/计费上游的强认证代理与审计 |
| `ctl` | 在商业 contract 成功后执行实例/能力开通 |

## 稳定不变量

- 支付成功、订单成功和权益生效是不同阶段，必须分别建模和验证。
- 回调、权益应用和开通都必须幂等；失败补偿不能重复创建外部资源。
- Credit 积分包是无续费能力的一次性资源包。Trade 只承载订单和外部计费协议，Credit 持有商品、
  live/history 积分包和用量真源；自然到期由 Credit 删除对应 LLMGateway 订阅并原子归档，计费隔离
  回调采用相同的同步销毁语义。
- 积分包用量使用定点小数存储，并通过带 CAS 租约的每日 outbox 调用 `sendResource`；普通零用量
  也要上报，到期或已归档资源不再推量。
- 计费通过 `getUsedAmount` 查询积分包用量时，购买周期以已完成的 `create_resource` Flow 原始请求
  为审计真源，并核对资源 ID、UIN、AppID、地域、付费模式和商品定义。该查询不能依赖
  `trade_order`，因为计费后台直接下单并支付的合法链路可能只有完整 Flow 而没有本地订单记录。
- Trade migration 版本号必须唯一；积分包定义表使用独立版本，不能与既有 Pass/变配 migration
  共用版本号。北京测试首次初始化时必须先完成 Trade/Credit schema migration，再分别用对应库账号
  幂等执行 `scripts/seed_trade_beijing_sandbox_credit_definitions.sql` 和
  `scripts/seed_credit_beijing_sandbox_products.sql`；商品引用同一 LLMGateway 控制面已有的 plan。
- 外部计费入向回调按产品类型隔离地域 route：Pass 使用 `jifei-callback-{region}`，Credit 使用 `jifei-credit-callback-{region}`；调整 Credit 的环境落点不能改变 Pass 路由。
- Trade 出向计费地域也按产品类型隔离：`LIGHTVELA_TRADE_REGION` 控制 Pass/default 链路，
  `LIGHTVELA_CREDIT_REGION` 仅控制 Credit 询价、下单、退款、资源回调和用量上报；后者未配置时
  继承前者。已接入环境分别使用北京 `ap-beijing`、东京 `ap-seoul`、上海 `ap-shanghai`、新加坡
  `ap-singapore`；单独切换 Credit 地域不得改变存量 Pass 的查询、退款、续费或回调校验地域。
- Credit 商品询价是可选登录态的展示链路。已登录请求优先按用户影子账号询价；匿名或尚未绑定
  影子账号的请求只允许使用目标环境的 `TRADE_INQUIRY_FALLBACK_UIN/APP_ID` 获取价格。该身份不得
  进入下单、支付、退款或资源归属链路，Service Gateway 也只能对精确的 Credit inquiry 路径放行。
- 只有 provider 成功创建 contract 后才能调用 CTL 开通。
- Pass 升配（同 SP 或产品允许的跨 SP）是支付后的异步发货：计费 `modifyResource` 成功只代表 CTL 已受理，
  `trade_order` 保持 `paid_pending_provision`、`trade_flow` 保持 `in_progress`；只有
  CTL 完成实例、Pass、配额与网关权益收敛并回调 Trade 后，才能分别进入
  `provisioned` 与 `completed`。系统盘扩容不可逆，失败只能幂等前滚，不能自动降配。
- 跨 SP 升配仍沿用同一 Pass/resource ID，且只允许源、目标属于同一 `productCode`。Trade
  使用目标套餐的 modify category 和顶层商品身份，`oldConfig`/`newConfig` 分别携带源、目标
  `productCode/subProductCode/pid/SV`；`checkModify` 与 `modifyResource` 必须在两侧各自 SP 内
  唯一反解套餐。跨二层下单使用目标 `goodsCategoryId`，但计费回调外层
  `para.productCode/subProductCode` 描述当前源资源，因此必须拒绝外层不是源身份、
  双侧 PID 不一致或缺失内层身份的请求；目标身份只信任 `newConfig`。
- 外部计费价格、活动和 API 规则属于外部 authority，不从历史文档直接采用。
- 2026-09-23 确认的对外首购展示口径为：新用户 Launch 与 Launch AI 首单均免费体验 1 个月。
  Launch 标准版与 Launch AI 的积分额度仍分别按套餐定义展示，不能因首页合并文案而互相推导。
  前端只在新用户且真实询价为零时展示免费标签；实际发放时长仍由服务端活动配置决定，源码、文档
  与内部事实表同步不等于生产配置已经核验。
- 前端只呈现服务返回的订阅/配额状态，不能成为唯一门禁。
- CTL 用户面 `GET /v1/passes` 与免费试用创建响应必须随 Pass 返回其 Bundle 的 `bundle_type`（`free` / `general` / `ai`）。该字段来自 Bundle 真源，不从 `bundle_id` 或套餐名称推断；前端遇到缺失或未知值时必须采用保守兼容行为。
- 邀请返利不复用访问邀请码。Auth 在新用户创建时写 `user.registered.v1`，存量用户在首次开通前认领时写
  `user.referral_claimed.v1`；CTL 在首个非免费 Pass 开通和退款隔离事务中写 versioned outbox。Referral
  通过 Pulsar inbox 去重并允许归因、首付、退款事实乱序到达，但只有归因事件发生时间不晚于首次开通
  时间时才允许创建奖励，防止已开通或续费用户事后补绑邀请码。
- 返利资格的用户口径是“首次开通成功”：dianshi 订单完成发货并开通 Pass 即符合，0 元订单也算，
  不检查现金实付金额。历史 `pass.first_paid.v1` 事件名保持兼容，不代表必须现金付费；无订单的旧免费试用不算。
- 默认返利奖励没有观察期（`vesting_days=0`），首次订单开通成功且归因齐备后进入待发，Worker 异步发放。
- 上海生产使用独立 Campaign 和 Pulsar 角色，奖励口径与北京一致但不共享 Campaign ID、Token 或预算。
  退款只取消其资格 Pass 对应的未发奖励，不自动追回已发积分。发放前 CTL 还要
  重新校验资格 Pass 的 owner、active 状态和有效期，避免退款事件延迟造成竞态。
- 已发 `free-credit:*` 是独立奖励权益。Pass 退款、隔离、销毁只能取消 `package:*`，不能按
  `free-credit:` 前缀清理奖励；账户清退、风控追回或运营纠错必须由奖励所有者提交精确
  `subscription_name` 撤销。Referral 运营重置先预览 Attribution/Reward，撤销已发权益后原子删除
  关系与奖励，并把操作人、原因、幂等键和完整快照写入独立审计表；首购/退款事实不得删除。奖励发放
  幂等键必须包含归因事件 generation，确保同一 Campaign 合法重新归因后不会复用已取消的旧订阅。
- 邀请人无 active Pass 时保留最多 90 天重试。两侧奖励使用独立幂等键；活动持有单邀请人上限、
  全局积分预算和 30 天奖励 Plan，前端常量不能替代这些服务端约束。

## 机器契约与验证

API 真源包括 `subscription/api/openapi.yaml` 与 `payment/api/openapi.yaml`，交易行为由 `trade` 源码/测试证明，积分包 contract 由 `credit/AGENTS.md`、Credit/Trade 实现与测试共同证明。验证覆盖重复回调、延迟回调、续费、过期、配额边界、provider/CTL 分段失败和恢复；积分包还需覆盖重复购买、退款隔离、精确订阅删除、自然到期归档、零用量推量和多 Pod 抢占。Pass 升配还须覆盖 `modifyResource` 早于/晚于订单落库两种竞态、CTL 完成回调重试，以及订单、flow、Pass、配额和网关权益的联合终态；跨 SP 额外覆盖双侧商品身份、目标 category、目标 Plan 创建/替换和计费退款查询关系。

## 计费代理认证边界

Trade 到 CloudLadder Gateway 的计费出向请求使用调用方 HMAC，签名覆盖 caller、route、
HTTP method、上游 path、query、时间戳和 body SHA256。签名只保护 Trade 到代理这一跳，
不等同于 jifei 请求体内的 `interface.auth`，也不能替代腾讯云 API 自身签名。

CloudLadder 认证按 `disabled`、`optional`、`required` 三态迁移。`optional` 允许完全无签名
请求继续通过，但只要出现任一认证头，就必须完整验签；因此它用于确认合法流量已标记为
`caller=lightvela-trade`，不能宣称已经阻断匿名访问。只有客户端、环境密钥和路由授权全部
收敛后才能切 `required`，敏感计费出向路由不得保留在匿名白名单。

jifei、Credit 和腾讯云账号入站回调不携带 CloudLadder HMAC。它们在 `required` 阶段必须
作为明确的回调路由豁免，不能因出向认证收口而中断；回调真实性由各自原生回调协议负责。
在 `billing_auth` 算法和真实样本尚未完成一致性验证前，不得猜测实现并直接拒绝生产回调。
匿名豁免只解决兼容性，不代表回调来源已经可信。

点石通过腾讯云 API `DescribePass` 回查资源时，`X-TC-Region` 表示计费资源地域，不表示 LightVela
控制面的部署地域。北京预发布的 Pass 计费资源使用 `ap-guangzhou`（`regionId=1`），CloudLadder
必须将 `ap-guangzhou` 和兼容保留的 `ap-beijing` 都转发到北京预发布 CTL；上海正式的
`ap-shanghai` 转发到上海 CTL。目标 CTL 的 `CTL_CLOUDAPI_ALLOWED_REGIONS` 必须与入口映射一致，
避免入口已正确分流但 handler 仍以地域不支持拒绝请求。

新加坡生产可独立于 testing 和国内环境切换 `required`。其生产计费路由
`jifei-prod`、点石和 Billing CloudAPI 必须验签；计费/账号回调继续使用上述明确豁免。
韩国测试 Trade 仍经新加坡生产 CLB 访问 `jifei-test` 时，只允许为该测试路由追加临时匿名
兼容，不能因此放开 `jifei-prod`。韩国完成签名版本发布后必须删除此临时例外。

Credit 每日用量的 `sendResource` 出向请求必须经过 CloudLadder，并使用
`caller=lightvela-trade` 的 HMAC 签名。北京 sandbox 与上海使用国内正式路由
`qbilling-send-resource-cn-prod`，固定转发到 `qbilling.billing.tencentyun.com`；东京与新加坡使用
国际正式路由 `qbilling-send-resource-intl-prod`，固定转发到
`intl.resource.qbilling.tencentyun.com`。仅北京 7 与首尔保留 `qbilling-send-resource-test` 和
`Host: qbilling.itd.com`。所有路由只允许 POST；Trade transport 与 CloudLadder 路由必须协同发布，
避免客户端先上线后因路由不存在返回 404。

广州生产严格模式覆盖上海正式与北京测试的生产计费出向；两者必须先完成 Trade 签名发布和
密钥一致性校验。广州 staging/testing 不随生产切换，sandbox-bj-7 的测试计费路径继续由
testing 入口承载，不应成为广州生产匿名例外。

## 个人 DevCloud testing 计费回调隔离（2026-09-17）

个人 DevCloud 运行 Auth、CTL、Trade、Payment、Subscription、AI Gateway、Sandbox、Service
Gateway 和前端的当前 checkout 代码；Account 与 Billing 继续访问真实 testing 服务。计费入站回调
按 `动态个人路由 → 既有静态 UIN 路由 → 共享 testing 默认路由` 解析，未登记的旧测试账号保持原有
行为。某 UIN 一旦登记，注销或 TTL 过期必须保留 disabled tombstone 并 fail closed，不能把旧订单
静默回落到共享环境。

国内动态目标只接受 Auth 从可信代理链派生的 DevCloud `9.x` 地址和 callback-only 端口 `18084`；
客户端不能提交 UIN、IP 或任意端口。国际站复用韩国 testing devtunnel，短期 capability 必须绑定
UIN、TunnelHost 与 TTL；Auth testing MySQL registry 只持久化 capability 的 SHA-256 摘要，DevCloud 不获得
共享 CloudLadder HMAC、SOPS 或 `DEVTUNNEL_TOKEN`。动态、静态和共享路径的优先级、注销、过期及
跨 UIN 拒绝都必须有测试证据。

CloudLadder 镜像内的默认配置必须显式声明默认关闭的 `developer_routes`，并把注册控制面固定为
`developer-route-control` / `lightclaw-auth`；该 caller 只复用服务端
`CLOUDLADDER_SHADOW_HMAC_SECRET`，且只能调用这一条控制面 route。只有广州、新加坡 testing
workload 可以通过环境变量开启动态注册。发布门禁必须直接加载最终打包的 `config.example.yaml`
验证 route、caller、secret env 与 `18084` 端口契约，不能只验证 handler 代码，避免出现接口已发布但
镜像配置未注册 caller 的运行时断层。

个人 DevCloud 的 signed billing 出向不复制 testing 长期 Secret。个人 Trade 对
`ModifyResourceStatus`、国际 `CreatePayUrl` 与 `DescribeOrderList` 保留原业务请求和 TC3 签名，但把请求
交给 Auth capability proxy；Auth 校验 active UIN 后用内部 Bearer 转给同站点中央 testing Trade，中央
Trade 再使用本环境 Jifei AppSecret 与 CloudLadder HMAC 代签。两层都必须使用静态 allowlist、固定 upstream
和 UIN 二次校验，个人请求不能提交目标 URL、route ID 或其他接口。该代理只解决个人环境的签名能力；
testing 账号开户和余额仍由受控账号工具负责，余额不足后必须新建订单，不能把旧 `pending` 单自动补付。

`verify-order-no-pay` 只证明询价和 `pending_pay` 下单成功，不证明支付、计费回调、发货或权益终态。
只有使用 testing mock 支付，并同时保存订单、真实回调和业务终态证据，才能宣称支付闭环；缺少任一
层证据时必须明确停在哪一层。

个人 testing 的支付、退款和销毁请求均按最多一次提交。客户端超时、`502/504`、空响应或端口转发
重连不代表上游未受理；必须先用 transaction/event/deal 核对计费与 Trade 日志，再核对
`trade_order`、`trade_flow`、Pass、Task、实例和订阅终态。只有同时证明没有计费订单、没有 Flow、
没有业务落单且回调未到达时，才能创建一笔新的 testing 请求，禁止重放原请求。readiness `200`
在调用计费前结束，只证明短期代理可用，不产生订单、扣费或回调。

一个源套餐存在多个合法升配目标时，CTL 对各目标询价并行执行但按服务端策略顺序返回；单目标预算为
20 秒，Service Gateway `ctl-passes` 上游预算为 30 秒。任一目标询价失败时整条请求失败，不能把临时
故障降级成“无可升级套餐”，也不能只展示部分目标诱导用户做出错误购买决定。

相关 Journey：[订阅购买与续费](../journeys/subscription-purchase-renewal.md)。Agent 摘要：[subscription-entitlements Context](../../context/domains/subscription-entitlements.md)。

## Pass 升配回调参数边界（2026-09-07，2026-09-20 扩展跨 SP）

Trade 的预付费 `checkModify` 与 `modifyResource` 入站均要求可解析且大于零的 int64 UIN，并要求有效的 `goodsDetail.curDeadline`（计费北京时间格式）。缺失或非法参数必须在调用 CTL 前拒绝；`modifyResource` 的参数级拒绝发生在占用 Flow 前，使用可重试的业务错误，不触发自动退款。不得用 UIN=0 或 deadline=nil 绕过 CTL 归属/期限校验。该收口的8个负向用例已先复现再修复；测试环境部署验收状态以当日 release-gates 为准。

CTL在Pass完成升配后继续支持原订单重投：依靠由Pass/Flow确定的持久化父任务，核对任务名称、owner、原订单及源目标套餐后返回原任务ID。此检查覆盖Trade受理响应未成功落库、但CTL先完成的窗口，也覆盖CAS竞争期间完成的窗口；缺乏匹配凭证不能仅凭目标套餐相同认作原单成功。原父任务负责继续重试Trade终态通知，不重复应用权益。

完成证明不能依赖Pass后续仍为active或仍使用原目标套餐。`FinalizeModify`在同一数据库事务内锁定原ModifyPass任务，验证归属、原Flow、源目标套餐与订阅步骤进度，原子完成Pass套餐/状态、quota替换及`task_params.entitlements_finalized=true`；任一写入失败须整体回滚。该标志采用既有JSON字段，无新增schema migration。它只证明原升配事务完成，不代表后续续费、隔离或另一轮变配的当前状态。

原单重投在身份和原任务参数精确匹配时，可凭该持久标志复用原受理任务，不因Pass进入renewing、isolated或后续套餐而拒绝并误退款，也不得反向改写当前Pass或再次发放权益。worker恢复必须重新读数据库凭证后补发原Trade完成通知，不能仅依赖启动时任务快照。`UpdateModifyPassPayload`须加行锁合并保存，保留数据库已置真的finalized标志及未知字段，避免旧任务快照将完成证明覆盖清除。

兼容边界：未带新标志的旧任务，仅保留原active+原目标套餐的有限恢复路径，不自动推断历史跨状态任务已经完成，也不自动查询历史HTTP回执补造凭证。已有任务参数/业务日志不等于完整历史HTTP响应信封；历史头、状态码和回执查询能力未实现时必须明确缺失，由原始记录及受控人工核对提供证据。

升配受理CAS同时匹配 `status=active` 和调用方已校验的源 `bundle_id`；若校验之后原任务已完成，旧请求不得重新抢占目标套餐。CAS未命中后以持久任务凭证区分同单完成重投与其他订单冲突。

## 有实例升配的部署与恢复检查

- CTL 与 Sandbox 的特权改配接口需要同一非空 `SANDBOX_API_KEY`。检查运行中消费者是否加载一致的密钥，只报告存在性和一致性，不输出密钥。更新固定名 Secret 后须验证消费者重启与真实接口鉴权；普通实例创建成功不能替代特权改配接口验证。
- 分片 worker 的实际副本、ordinal 与 `shard-total` 必须覆盖完整分片集合。测试环境缩容时同步检查分片参数，避免支付后的操作落入无人消费的分片。
- 升配停机与普通暂停是不同的 provider 操作：普通暂停保留省费策略；变配使用专用停机准备与云状态回读，支持旧任务在计算规格变更步骤恢复。外部云限制须查官方接口，测试现场错误不能被归因为计费回调失败。
- 云规格改变、磁盘扩容和开机后仍须完成 Sandbox Pool 归属回写、实例可用性校验、CTL 权益收敛及 Trade 终态。元数据长度应遵守持久化 schema，完整操作关联存放在 operation 账本，不挤入短来源分类字段。
- 对已支付在途单保留原 Flow/task/operation，以幂等恢复验证修复。未经终态回读，不因HTTP200、云实例RUNNING或单个步骤完成宣布升配闭环。
