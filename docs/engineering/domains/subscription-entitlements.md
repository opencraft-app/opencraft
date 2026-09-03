# 订阅与权益领域

本领域覆盖套餐、订阅、Pass、配额、订单、支付、续费与外部计费。它由多个服务分阶段拥有，不能用一个前端字段或单张订单表代表完整状态。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `subscription` | 套餐、当前订阅、续费和权益应用 |
| `payment` | 支付链接/回调 contract 与支付侧幂等 |
| `trade` | 订单、计费 provider 和成功后的开通编排 |
| `cloudladdergateway` | 到 IDC/计费上游的强认证代理与审计 |
| `ctl` | 在商业 contract 成功后执行实例/能力开通 |

## 稳定不变量

- 支付成功、订单成功和权益生效是不同阶段，必须分别建模和验证。
- 回调、权益应用和开通都必须幂等；失败补偿不能重复创建外部资源。
- 外部计费入向回调按产品类型隔离地域 route：Pass 使用 `jifei-callback-{region}`，Credit 使用 `jifei-credit-callback-{region}`；调整 Credit 的环境落点不能改变 Pass 路由。
- 只有 provider 成功创建 contract 后才能调用 CTL 开通。
- 同 SP 升配是支付后的异步发货：计费 `modifyResource` 成功只代表 CTL 已受理，
  `trade_order` 保持 `paid_pending_provision`、`trade_flow` 保持 `in_progress`；只有
  CTL 完成实例、Pass、配额与网关权益收敛并回调 Trade 后，才能分别进入
  `provisioned` 与 `completed`。系统盘扩容不可逆，失败只能幂等前滚，不能自动降配。
- 外部计费价格、活动和 API 规则属于外部 authority，不从历史文档直接采用。
- 前端只呈现服务返回的订阅/配额状态，不能成为唯一门禁。

## 机器契约与验证

API 真源包括 `subscription/api/openapi.yaml` 与 `payment/api/openapi.yaml`，交易行为由 `trade` 源码/测试证明。验证覆盖重复回调、延迟回调、续费、过期、配额边界、provider/CTL 分段失败和恢复。同 SP 升配还须覆盖 `modifyResource` 早于/晚于订单落库两种竞态、CTL 完成回调重试，以及订单、flow、Pass、配额和网关权益的联合终态。

相关 Journey：[订阅购买与续费](../journeys/subscription-purchase-renewal.md)。Agent 摘要：[subscription-entitlements Context](../../context/domains/subscription-entitlements.md)。

## 同 SP 升配回调参数边界（2026-09-07）

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
