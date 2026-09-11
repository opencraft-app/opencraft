# LightVela 同 SP 升配：腾讯计费生产发布 TODO

> 日期：2026-09-07
>
> 范围：仅梳理腾讯计费侧上线前置、与 LightVela 发布的交界面及证据缺口。
>
> 非目标：本文不执行计费接入单、TAPD、GitOps、云资源或生产变更，也不发起任何真实询价、下单、支付、退款请求。

## 结论

2026-09-07 19:37增量：finalized修复CTL digest `2a9b8ed7103d2ee0ef3c358c82458af83368d940150358b2b1977aea0387aa62`已在两站api/service/bypass Ready。北京新marker+NULLreceipt后真实重投恢复、韩国AI升级终态及清理已有现场证据；续费尝试被100151拒绝，未验证renewing现场路径。**可交付不等于生产全绿签署**。韩国新购provider100238观察属于已发布旧链路，另行交给对应 owner，不阻塞本次同 SP 升配代码 MR。

本次不是重新接入新购/续费，也不是新建 SP、PID 或整套商品。四个 SP 已有新购、续费定义，本次新增工作应严格收敛为：在四个**既有接入单**的既有变更单中，把 `变配` 能力正式发布到现网，完成该步骤要求的财管审核，回读四个现网 Modify CategoryID 与异步回调配置，再由 LightVela 分站点写入 `scene='modify'` 并灰度开放。

截至2026-09-07 18:58，两站测试正常矩阵（通用/AI × 零实例/有实例）8/8已真实闭环，最新CTL/Trade与Sandbox修复已部署测试消费者；具体订单、Flow、云规格及清理证据见[上线门禁记录](../context/tasks/2026-09-07-pass-same-sp-modify-release-gates.md)。同日只读回读确认四个原接入单均为“已完成”，但四个新增变配能力的变更单仍停在第2步“测试环境验证变更”，尚未正式发布现网。这里缺的是计费变更单正式发布及其回读证据，不是业务代码或测试环境链路故障。

追加跨状态风险：旧完成态receipt/worker重试依赖Pass active，后续renewing/isolated或后续套餐可能让原升配重投拒绝并误退款。现源码已完成finalized凭证与Pass/quota同事务、worker回读数据库凭证、加锁合并保留marker；三场景RED→GREEN，CTL全量/vet/受影响包race通过，无需migration。新候选已两站部署并通过限定现场验证，**跨状态live仍未覆盖，不能签署全部门禁通过**。原flow/deal跨状态复用和延迟complete仍需对应现场证据；旧8/8正常矩阵不能替代。计费侧需owner确认原单真实重投、退款语义和流水查询办法，当前不改计费配置；未实现自动历史HTTP回执查询，不以业务日志伪造历史响应信封。

正常矩阵完成与异常时序门禁分开：北京首轮受理响应丢失、真实计费retry1及唯一Flow终态已通过并清理；精确完成态+NULLreceipt窗口另在补测，不将响应丢失等同精确SQL写失败。生产发布、财管、现网CategoryID/回调和灰度项保持TODO，本文未代办或执行。

韩国通用真实链路已经证明现有新购与新增变配协议可以串起来：真实新购为 Flow 46、零实例升配为 Flow 47，订单/Flow 均到终态；但它只覆盖国际测试环境、通用套餐、零实例，不覆盖国内/AI、有实例扩盘、生产路由或生产商品状态。证据见 `docs/context/tasks/2026-09-07-pass-same-sp-modify-release-gates.md:84-94`。

## 明确不重复做的既有接入

- 不新建国内/国际通用、AI 的 SP/PID。四组 SP/PID 已在原需求与 seed 脚本固定，见 `scripts/seed_trade_modify_scene_category.sql:15-25`。
- 不改新购/续费 CategoryID，不整列重写 `category_ids`。seed 只追加 `scene='modify'`，保留 purchase/renew，见 `scripts/seed_trade_modify_scene_category.sql:4-13,64-66`。
- 不重新开发或登记 `checkCreate`、`createResource`、`queryResource`。真实新购 Flow 46 已成功，只作为兼容性回归证据，不是本次新增计费工作。
- 不把“新购成功”当成“变配现网已接入”。`goodsCategoryId` 按业务和交易场景全局唯一，变配必须使用自己的 CategoryID；计费知识库《goodsCategoryId 介绍》明确它同时决定具体业务与新购/变配/续费路由。

## P0：证据确定的上线必做项

### 1. 在四个既有变更单中完成现网发布和财管审核

| 站点/类型 | 既有接入单 | 既有变更单 | 测试/预发 Modify CategoryID |
|---|---:|---:|---:|
| 国内通用 | 23472 | 2095070107168092162 | 2025048 |
| 国内 AI | 23585 | 2095076030343729153 | 2025275 |
| 国际通用 | 23563 | 2095076989500862466 | 2025257 |
| 国际 AI | 23584 | 2095077899558703106 | 2025272 |

必须逐单回读并留证：

- 变更单已从测试/预发正式发布到现网，不只是生成了联调 CategoryID。
- 预付费收入递延方式已由财管确认，平台要求的财管审核已完成；若沿用既有新购/续费收入递延方式，应留存“沿用且无需新增配置”的明确审核结论，不能自行假设。
- 现网页面显式显示 `(变配)` 对应的 CategoryID、站点、SP、付费类型、售卖模式和状态，且与上表逐项一致；若现网重新发号，以现网页面为准，禁止按“续费 + 1”推算。
- 只修改四个既有变更单的变配能力，不创建一套重复的新购接入单。

依据：

- `scripts/seed_trade_modify_scene_category.sql:38-54`：四个接入单、变更单和测试/预发 CategoryID 的实测回读；同时明确 2026-09-02 仍未发布现网。
- `docs/handover/2026-09-02-pass-same-sp-modify-runbook.md:38-43,407-421`：生产 seed 前须确认正式发布和财管审批。
- iWiki [《确认接入计费场景以及了解接入计费流程》](https://iwiki.woa.com/p/4010253217) §1.1、§2.3（版本 32，2026-06-24 更新）：国内/国际接入隔离；预付费收入递延方式须提前由部门财管确认，接入过程中需财管审核后才能继续。

完成证据：每个变更单各保存一份不含敏感值的页面截图/导出，记录接入单号、变更单号、现网状态、审核状态、Modify CategoryID、最后操作时间和复核人。

### 2. 现网回调配置必须覆盖完整异步变配协议

四个 SP 的生产配置必须分别确认以下接口及异步发货选项：

- `lightvela.pass.checkModify`：同步扣款前校验，计费侧 3 秒超时；成功必须返回 `data.status=0`。
- `lightvela.pass.modifyResource`：支付后发货，计费侧 5 秒超时；本项目使用异步模式，成功必须返回非 0 `flowId`，并支持同订单重入。
- `lightvela.pass.queryFlow`：按 `flowId` 查询终态；`0=成功`、`2=处理中`、`3=失败并退款`。

仓库实现已注册上述 interfaceName，并为 check/modify 设置 2 秒/4 秒 handler 预算，见 `trade/internal/httpapi/jifei/callback.go:60-66`、`trade/internal/httpapi/server.go:256-280`、`trade/internal/logic/checkmodify/handler.go:58-64,96-153`、`trade/internal/logic/modifyresource/handler.go:74-84,163-177`。但源码注册不等于计费接入单和生产入口已生效。

计费平台还规定：同一站点、子产品、地域共享同一套回调地址。变配上线时应复用并保护已有新购/续费生产回调路径，不要为了变配替换整套共享 URL；若确需修改 URL，必须把新购、续费、变配一起做回归。依据为 iWiki [《确认接入计费场景以及了解接入计费流程》](https://iwiki.woa.com/p/4010253217) §1.2、§2.2。

完成证据：四个变更单分别回读 interfaceName、URL/路由标识、站点、地域、异步模式；在不支付的受控检查中确认生产入口能到达预期 Trade workload，且新购/续费既有路由未被改坏。不得用 GitOps 文件或域名 DNS 可解析代替生产 workload 回读。

### 3. 回读现网商品、价格与审核同步状态

变配会复用已有 SP/PID/SV，但仍必须确认现网定价状态满足变配：

- 四个 SP/PID 在对应站点现网可售、已审核同步，不处于 PID 不可售卖或“已配置但未审核同步”状态。
- Launch/Cruise、Launch AI/Cruise AI 的 oldConfig/newConfig SV 与现网计价策略一致；不能只看 Trade DB。
- 变配按月价计算差价；即使套餐按年售卖，计费知识库也要求存在按月价格。
- 现网未支付询价结果应为剩余期限差价，币种/税费与站点一致，且不改变到期时间。该检查只能在获得生产验证授权后执行，本文不发请求。

依据：

- iWiki [《变配能力（预付费）》](https://iwiki.woa.com/p/747239245) §变配公式、§联调&测试验证（版本 38，2026-03-05 更新）：升配按剩余期限和新旧配置月价差计算；变配不改变到期时间；需验证扣款、订单金额和订单详情。
- iWiki [《下单接口 - qcloud.Deal.generateDeals》](https://iwiki.woa.com/p/754661947) 的错误码说明（版本 142，2026-09-04 更新）：`500109` 表示 PID 不可售卖，`500010` 表示 PID 未配置或未审核同步，`500102/500103/500104/500105/500204` 指向价格策略或询价参数异常。
- `scripts/seed_trade_modify_scene_category.sql:64-66`：现有 purchase/renew 定义保持不动，只追加 modify。

完成证据：磐石/接入平台商品状态截图，四条未支付询价的脱敏结果摘要，以及 old/new SV 与 Trade BundleDefinition 的逐字段比对结论。发现差异时修现网商品定义或业务定义，不复制一套新 SP/PID 规避问题。

### 4. 支付安全校验必须在扣款前闭合

平台加签策略选择“**不强校验加签**”，不新增 SecretID/SecretKey。该选择与历史新购/续费实现一致：完整计费参数由 Trade 后端依据已认证用户、Pass 和服务端 BundleDefinition 构造后直连 CGW，浏览器不能提交或覆盖 `goodsCategoryId`、PID/SP/SV、oldConfig/newConfig 等完整计费参数；现有 jifei client 也明确不发送 `auth.signature`。安全门禁落在服务端参数派生、CGW 路由/来源鉴权，以及下述严格 `checkModify` 校验。若未来改成由前端透传完整计费参数，或计费平台强制签名，再单独评估密钥方案。

计费官方要求 `checkModify` 同步且严格校验资源归属、地域、当前到期时间、oldConfig、newConfig、PID/SP 和计费参数/发货参数一致性，防止低价高配或篡改到期时间。依据为：

- iWiki [《变配检查接口 - checkModify》](https://iwiki.woa.com/p/754666943) §要求、§请求参数（版本 32，2026-03-18 更新）。
- iWiki [《云产品支付安全》](https://iwiki.woa.com/p/829674271) §变配 0 元购/低价购、§支付风险场景、§变配/续费修改 oldConfig（版本 52，2024-11-14 更新）。

2026-09-07 本地代码已按官方协议收口这两个差异：

1. `checkModify` 与 `modifyResource` 都使用 `strconv.ParseInt(..., 10, 64)` 并要求 UIN `> 0`，非法、零值和 int64 溢出值会在进入 CTL 前拒绝，不再把 `0` 传给 CTL 跳过归属校验，见 `trade/internal/logic/checkmodify/handler.go:157-163,289-300`、`trade/internal/logic/modifyresource/handler.go:379-381,429-436`。
2. 两个回调都把预付费 `curDeadline` 设为必填并按北京时间协议格式解析；缺失或格式错误会 fail-closed，见 `trade/internal/logic/checkmodify/handler.go:273-291`、`trade/internal/logic/modifyresource/handler.go:395-426`。

新增 InvalidPara 覆盖在两个 handler 中分别验证非法 UIN、零 UIN、溢出 UIN和缺失 `curDeadline`，共 8 个 RED → GREEN 场景；参数错误不会调用 CTL，`modifyResource` 还会在抢占 `trade_flow` 之前返回，见 `trade/internal/logic/checkmodify/handler_test.go:257-294`、`trade/internal/logic/modifyresource/handler_test.go:343-392`。主任务最新本地证据为 Trade 全量测试、vet 和受影响包 race 通过；本次只读复核另执行：

```text
go test ./internal/logic/checkmodify ./internal/logic/modifyresource -count=1
ok  git.woa.com/wisp/mono/trade/internal/logic/checkmodify
ok  git.woa.com/wisp/mono/trade/internal/logic/modifyresource
```

严格参数校验本身未发现正常回调兼容退化；异步受理幂等复核曾发现“已履约但退款”的 **P0 风险**，2026-09-07 已完成本地代码修复，但在部署后真实故障注入通过前仍按 P0 发布门禁管理：

- `modifyResource` 的坏参数在 `TryAcquireSlot` 前被拒绝，不会留下占位孤儿。
- 原风险是：首次 CTL 已受理并派发父任务，但 Trade 的 `RecordAcceptedByID` 因瞬时 DB 故障未写入 `resource_id/response_body`；零实例或快速任务随后先把 Pass 切到目标套餐并清零 `modify_flow_id`，而 `/flows/{id}/complete` 因 acceptance metadata 缺失返回 `503 FlowNotAccepted`。计费重投若被 CTL 按旧源套餐不一致返回 409，Trade 会把该 4xx 映射成 `352014 / DeliveryFailRefund`，形成“资源权益已经升配，但订单退款”，见 `trade/internal/logic/modifyresource/handler.go:146-208,300-332`、`ctl/pkg/model/pass/modify_dao.go:35-51`、`ctl/pkg/pass/worker/modify_task.go:174-198,368-391`、`trade/internal/httpapi/internalapi/handler.go:1060-1099`。
- CTL 现已用确定性父任务作为完成态持久凭证：仅当 Pass 为 `active + 目标套餐`，UIN/AppID 正确，且任务记录精确匹配 task 类型、pass、user、source、target、flow、deal，并处于 `CREATED/RUNNING/SUCCESS` 时，才复用原 task ID 返回受理成功；不重新派发任务或重复应用权益。入口常规校验失败和 CAS 失败后重读期间完成两条路径都走该凭证，见 `ctl/pkg/logic/pass/modify.go:72-76,117-156,165-176`。
- 同时，`TryAcquireSlotForModify` 的 CAS 已新增必填源套餐，并将 `bundle_id=sourceBundleID` 纳入 `active → modifying` 的原子条件；即使常规校验后原任务恰好快速完成，旧源观察也不能重新抢占已经变成目标套餐的 Pass，未命中后转入上述完成态凭证判断，见 `ctl/pkg/logic/pass/modify.go:83-89`、`ctl/pkg/model/pass/modify_dao.go:17-32`。
- 新增 `TestAcceptPassModifyCompletedSameFlowUsesDurableReceipt` 覆盖 `CREATED/RUNNING/SUCCESS`、CAS 失败后完成以及 flow/deal/UIN/source 不匹配拒绝；`TestTryAcquireSlotForModify_DoesNotReacquireCompletedTarget` 在原实现上 RED、加入源套餐 CAS 后 GREEN，见 `ctl/pkg/logic/pass/modify_completed_retry_test.go:19-64`、`ctl/pkg/model/pass/modify_dao_test.go:92-109`。截至本文更新，CTL model/logic 定向测试、`go test -p 4 ./... -count=1`、`go vet ./...` 以及 `pkg/model/pass`、`pkg/logic/pass` race 均已通过。
- 若 acceptance 已成功持久化，则重复回调会直接回放原 `flowId`，不重复调用 CTL；这条正常路径仍成立，见 `trade/internal/logic/modifyresource/handler.go:335-376`。
- 受理成功只写 acceptance metadata，Flow 保持 `in_progress`；仍由 CTL 父任务收敛后推进 order/flow 终态，没有把同步“受理成功”误当作异步“履约完成”，见 `trade/internal/logic/modifyresource/handler.go:176-210`。
- 官方协议本就要求正整数资源 owner UIN 和预付费 `curDeadline`；此前韩国真实回调也带齐两项，因此没有证据显示该严格校验会拒绝正常计费回调。

当前状态：严格参数校验和完成态receipt/source-CAS修复已部署北京bj7与韩国kr1。两站CTL api/service/bypass使用digest `dc77d73e2cb6df610b75dc59f4dfb8568a15c2a6b52e96dc711ba60add8c5952`，Trade使用digest `3f18ffcd2ef01dd5373f23b5f564e059467077556ac99643522db1578b73a3aa`；正常真实计费回调及8项矩阵已收敛，不能再描述成“修复未部署”。仍未完成的是指定异常时序的live门禁：受理未持久化、父任务已完成、真实计费重投时须复用原task/flow，不退款、不重做权益，并让order/flow最终收敛。

临时双向代理harness仅在指定测试Pass/deal/flow上丢一次真实CTL成功响应、暂缓指定complete，默认不注入，具有TTL与次数上限；它不生成计费回调、也不直接写DB。首轮18:51:13实际600903→计费自动retry1成功，18:53:57唯一Flow352 completed，18:58:21原接线恢复、临时资源已撤销；验证“受理响应丢失恢复”，不冒充`RecordAcceptedByID`精确SQL失败。确定性CAS竞态仍以本地回归为现有证据，精确完成态补测仍须取得可排序证据才可签署。计费接入平台配置和生产保持未操作。

### 5. 明确退款、重试和不可逆阶段的责任边界

协议确定项：

- `modifyResource` 明确永久无法发货时返回 `352014 / DeliveryFailRefund`，计费取消订单并退款；其他错误默认持续重试。
- 异步 `queryFlow status=3` 表示无法发货、取消订单并退款；`status=2` 继续查询。
- 同订单 `modifyResource` 会重投，业务必须按订单号幂等。

依据为 iWiki [《变配发货接口 - modifyResource》](https://iwiki.woa.com/p/754666978) §要求、§需要直接退款/取消订单（版本 35，2026-03-18 更新）和 [《异步任务查询接口 - queryFlow》](https://iwiki.woa.com/p/754667032) §要求、§返回参数（版本 27，2026-03-12 更新）。仓库将 CTL 4xx 映射为退款、5xx/网络错误映射为重试，见 `trade/internal/logic/modifyresource/handler.go:300-332`。

LightVela 特有风险：一旦实例开始系统盘扩容，就没有安全的自动降配回滚；当前 CTL 父任务会持续前向重试，Trade 只告警、不自动标记失败退款，见 `ctl/pkg/logic/pass/modify.go:32-40`、`trade/internal/worker/reconcile.go:99-109,516-533`。因此上线前必须由产品、计费/财管、客服/SRE 明确以下处置：

- 哪些失败发生在不可逆动作前，可以安全返回退款。
- 不可逆动作已部分成功但长时间不收敛时，是继续履约、人工补偿还是特殊退款；谁审批、谁执行、如何对账。
- 停止新流量时如何处理已支付且 `in_progress` 的订单；不能用回滚镜像或删除 seed 代替在途订单收敛。

未形成书面处置前，不应开放有实例生产流量。

测试清理的新证据：韩国AI有实例和北京AI有实例都出现过短时100151 `ERR_RESOURCE_LOCK`，随后均在正常业务流程内退款/隔离/销毁成功，未删库或伪造回调。因此它不是当前韩国测试账号无法复用的阻塞，也没有证据证明它仅发生于国际站。计费终态传播期间如何处理资源锁、等待多久以及上游错误被CTL转为404的可观测性，仍应纳入退款SOP/错误分层审查；不要把该404当作资源不存在。

## P1：LightVela 发布门禁，非计费平台自动强制项

### 6. 生产路由必须按“期望配置 → GitOps → workload → 回调”逐层验真

仓库声明的期望配置显示国内、国际 Trade 使用不同生产部署和站点/地域参数，见 `argocd/services/trade/shprod/trade-platform.env:13-26`、`argocd/services/trade/sgprod/trade-platform.env:22-57`。这只能证明 Git 中的目标值，不能证明接入平台回调已指向正确 URL、CloudLadder 路由已加载、Pod 镜像/环境已生效。

上线前逐站回读：

- 接入平台：该 SP/地域的回调地址和异步开关。
- CloudLadder/入口：生产 route、upstream、鉴权和超时配置实际加载。
- Argo/workload：预期 revision、镜像 digest、`Synced`/`Healthy`、Pod 环境中的 site/region 和入口路径。
- Trade：`/trade/jifei/callback` 能分发三个 interfaceName，且回调延迟满足 3 秒/5 秒预算。
- 新购/续费回归：共享回调地址未因变配改动而退化。

生产验真需另行授权；本文只列 TODO。

### 7. 建立可执行监控，而不是只保留日志关键字

当前 `modify_resource` 超过 6 小时只打印 `modify_resource_alert`，不主动退款或改状态，见 `trade/internal/worker/reconcile.go:99-109,516-533`。生产开放前至少需要：

- 回调层：`checkModify`、`modifyResource`、`queryFlow` 请求量、P95/P99、超时率、业务码分布、重复回调量。
- 订单层：`pending_pay`、`paid_pending_provision`、`provisioned`，以及按年龄分桶的 `trade_flow in_progress/failed`。
- 履约层：Pass `modifying` 时长、ModifyPass 父/子 task、Sandbox `modify_operations` 步骤与错误、实例规格/磁盘/Pool 终态。
- 资金层：变配订单金额异常、`352014`/`queryFlow=3` 退款量、计费订单与本地订单/资源对账差异。
- 告警责任：6 小时告警的值班人、排障入口、升级路径和人工处置 SLA。

### 8. 分站点、分套餐灰度并保留止血开关

“国内先灰度并观察至少 24 小时，再评估国际站”是本需求的产品/工程发布决策，不是计费协议自身要求，见 `docs/context/tasks/2026-09-07-pass-same-sp-modify-release-gates.md:20-21,119-123` 和 runbook `:420-421`。

建议顺序：国内通用小流量 → 国内 AI → 观察至少 24 小时 → 国际通用 → 国际 AI。每一步都要独立检查订单、退款、回调、Pass、实例、权益和监控后再扩量。

当前实现没有独立功能开关，以 `scene='modify'` seed 作为入口门禁，见 `docs/context/tasks/2026-09-07-pass-same-sp-modify-release-gates.md:121-123`。上线前应确认可以按站点/SP 单独启停；删除 seed 只能阻止新询价/下单，不能回滚已支付在途单。若运营 SQL 无法做到单 SP 灰度，应在发布前补一个可审计的流量门禁方案。

## P2：待计费团队确认的建议项

### 9. 是否必须接入主动 `dealDeliveryCallback`

iWiki [《异步任务查询接口 - queryFlow》](https://iwiki.woa.com/p/754667032) 明确指出仅靠计费轮询可能在最长 12 小时间隔内造成资源锁、续费页延迟和收入跨期，建议业务主动调用 `dealDeliveryCallback`，把 queryFlow 作为保底；[《订单处理结果业务回调计费 - dealDeliveryCallback》](https://iwiki.woa.com/p/800652963)（版本 33，2026-07-02 更新）给出了成功、全失败退款和部分失败退款语义。

当前变配完成路径是 CTL 回调本地 `POST /internal/trade/flows/{flow_id}/complete`，Trade 更新本地 order/flow，随后等待计费 `queryFlow` 看到终态，见 `ctl/pkg/pass/worker/modify_task.go:368-391`、`trade/internal/httpapi/internalapi/handler.go:1006-1104`；没有看到变配终态主动调用 `dealDeliveryCallback`。

这不影响韩国测试 Flow 47 通过，但生产前应请计费团队确认：

- 对该四个 SP 的异步变配，主动回调是强制接入项还是推荐优化。
- 若必须接入，接口、鉴权、国际/国内路由、幂等和失败重试如何配置。
- 若允许只用 queryFlow，最大状态不一致窗口和收入确认影响是否被财管接受，并设置更积极的轮询/告警。

### 10. 计费侧停用/回滚能力和审批时长

当前证据没有说明变配能力正式发布后，接入平台能否按单个 SP 即时停用、是否需新变更单、是否影响共享新购/续费回调，也没有四单财管审批 SLA。上线排期前向计费接入支持确认：

- 单 SP 关闭变配的最小操作及生效时延。
- 回退现网变更是否会改变 CategoryID 或影响在途订单。
- 国内/国际四个变更单能否分批发布和分批审批。
- 审批失败或驳回后的修订路径、预计周期和责任人。

这些目前只能列为待确认，不能写成已有平台能力。

## 上线前签字清单

| 门禁 | 责任方 | 通过证据 | 当前状态 |
|---|---|---|---|
| 四个变更单现网发布 | 计费接入 owner | 逐单现网状态 + CategoryID 回读 | 四单均在第2步“测试环境验证变更”，尚未发布，P0 |
| 财管审核/收入递延 | 产品财管 + 接入 owner | 四单审核记录或明确复用结论 | 未核实，P0 |
| 三个回调与异步模式 | 计费接入 + Trade | 四单回调配置回读 | 未核实，P0 |
| 商品可售与月价策略 | 产品 PD + 计费 | PID/SP/SV/价格已审核同步 | 未核实，P0 |
| 支付安全严格校验 | Trade/CTL + 安全 | 本地负向测试 + 部署后真实正常回调复测 | 本地通过、两站测试已部署且正常矩阵通过；生产配置/发布另验 |
| 两站正常功能矩阵 | Trade/CTL/Sandbox | 通用/AI × 零/有实例，订单/Flow/权益/云规格及清理 | 测试8/8通过；不替代异常时序和生产验收 |
| 完成态重投幂等 | Trade/CTL | 受理未持久化 + CTL已完成 + 真实重投，不退款、不回退状态且终态收敛 | 最终marker候选两站已部署；北京active+NULL回执→真实retry恢复已验证。renewing/isolated/later-bundle仅本地RED→GREEN，P1现场覆盖待验；SQL失败/CAS时序未live注入 |
| 已发布新购链路的100238异常观察 | Trade + 国际计费owner | 独立问题中对账deal20260907002021870403681及补偿语义 | 本需求外另行跟踪，不阻塞升配代码MR或升配变更单发布判断 |
| 退款/不可逆失败 SOP | 产品 + 财管 + 客服/SRE | 书面 SOP、责任人与 SLA | 未核实，P0 |
| 生产路由与 workload | SRE + Trade | revision/镜像/route/回调探测 | 未执行，P1 |
| 监控与告警 | SRE + Trade/CTL/Sandbox | dashboard、规则、值班人 | 未核实，P1 |
| 国内灰度 24h | 发布 owner | 订单/flow/退款/资源/权益报告 | 未执行，P1 |
| 国际分批开放 | 发布 owner + 国际计费 | 国内观察通过后的单独审批 | 未执行，P1 |
| 主动完成回调 | 计费团队 + Trade | 必要性书面结论 | 待确认，P2 |
| 平台停用/回退 | 计费接入 owner | 操作说明与生效时延 | 待确认，P2 |

## 证据索引与时效边界

- TAPD [1010132091137784162](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091137784162)：2026-09-07 只读查询时状态为“新”、优先级 High、`仅产研自测=是`。它定义开发/验收范围，但不构成计费现网发布或财管审批证明。
- `scripts/seed_trade_modify_scene_category.sql:38-54`：2026-09-02 四个测试/预发变更单回读；这是历史快照，不证明 2026-09-07 现网状态。
- `docs/context/tasks/2026-09-07-pass-same-sp-modify-release-gates.md`最新8项矩阵：北京通用零339/340、AI零327/336、通用有343/344、AI有347/348；韩国通用零46/47、AI有50/51、通用有54/55、AI零58/59。所有创建/变配Flow completed、订单provisioned，终态与云规格见逐项证据；均不代表生产验收。
- `trade/internal/logic/checkmodify/handler.go`、`trade/internal/logic/modifyresource/handler.go` 及对应InvalidPara测试：非法/非正/溢出UIN与缺失curDeadline本地负向回归通过，修复已部署两站测试Trade，正常真实回调复测通过。
- `trade/internal/logic/modifyresource/handler.go`、`ctl/pkg/logic/pass/modify.go`、`ctl/pkg/model/pass/modify_dao.go`及回归测试：持久父任务receipt和源套餐CAS已进入测试候选；CTL全量/vet/race通过，真实故障时序仍待完成，不提前解除P0门禁。
- `docs/handover/2026-09-02-pass-same-sp-modify-runbook.md:407-422`：现有工程发布门禁和 24 小时国内灰度决策。
- 腾讯云计费知识库：
  - [接入流程与财管审核](https://iwiki.woa.com/p/4010253217)
  - [预付费变配能力](https://iwiki.woa.com/p/747239245)
  - [下单接口](https://iwiki.woa.com/p/754661947)
  - [checkModify](https://iwiki.woa.com/p/754666943)
  - [modifyResource](https://iwiki.woa.com/p/754666978)
  - [queryFlow](https://iwiki.woa.com/p/754667032)
  - [支付安全 checklist](https://iwiki.woa.com/p/829674271)
  - [dealDeliveryCallback](https://iwiki.woa.com/p/800652963)

本文在 2026-09-07 已只读逐单查看计费接入平台：四个原接入单均“已完成”，四个新增变配能力的变更单均停在第2步“测试环境验证变更”。未点击检查、确认或发布按钮，也没有触发生产计费请求；正式操作前仍应重新实时回读，防止状态漂移。
