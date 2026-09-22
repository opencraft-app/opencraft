---
id: pass-cross-sp-modify
type: task
status: complete
owner: shawnmy
---

## goal

在保持既有同 SP 升配不变的前提下，实现并验证 LightVela Pass 从通用 SP 升配到 AI SP：`Launch → Launch AI`、`Cruise → Cruise AI`、`Launch → Cruise AI`。

## non_goals

- 不重新实现 `Launch → Cruise`、`Launch AI → Cruise AI`，只做回归。
- 不支持 `Cruise → Launch AI`、AI → 通用套餐、降配或跨地域变配。
- 本轮不提交、推送、创建 MR、修改生产、GitOps 或共享环境。

## requirement_ids / requirement_refs / requirement_excerpt

- TAPD `1010132091137784162`：既有 Pass 变配需求；同 SP 能力已完成，本任务扩展跨 SP。
- 计费跨二层官方说明：iWiki `1524204393`；使用目标配置的 `goodsCategoryId`，国内、国际分别配置源/目标二层和退款查询关系。
- 计费协议：询价 `746616075`、`checkModify` `754666943`、`modifyResource` `754666978`。

## interface_refs / data_structure_refs

- `ctl/pkg/logic/pass/modify_policy.go`：允许升配关系。
- `trade/internal/logic/inquiry/modify.go`、`trade/internal/logic/placeorder/modify.go`：询价与下单门禁。
- `trade/internal/jifei/modify_config.go`：`oldConfig`/`newConfig` 的独立计费三元组。
- `trade/internal/logic/checkmodify/`、`trade/internal/logic/modifyresource/`、`trade/internal/bundleresolve/`：跨 SP 回调反解与校验。
- 不变量：源、目标 `productCode` 相同；源/目标各自使用自己的 `subProductCode`、PID 和 SV；出向下单 `goodsCategoryId` 与顶层 goodsDetail 身份取目标套餐；计费回调外层 `para.productCode/subProductCode` 描述当前源资源，目标身份由 `newConfig` 自描述；地域保持不变；沿用同一个 Pass/resource ID。

## history_context

- `current_design_refs`：`docs/context/tasks/2026-09-07-pass-same-sp-modify-release-gates.md`、当前源码和测试。
- `relevant_evolution`：同 SP 的 `Launch → Cruise`、`Launch AI → Cruise AI` 已完成；本任务改造前 Trade 仍显式拒绝不同 `SubProductCode`。
- `superseded_refs`：旧 Agent/SOP 结论仅供定位，不作为验收证据。

## acceptance

- 三条新增路径均出现在服务器允许目标中，询价和下单生成正确的源/目标自描述报文。
- `checkModify`、`modifyResource` 能分别反解源、目标 SP，并拒绝产品、PID、SV 或外层源资源域不一致的请求。
- 通用 → AI 发货后 AI Gateway 权益正确创建或切换；`Launch → Cruise AI` 同时完成规格和权益升级，且地域不变。
- 既有两条同 SP 路径及非法路径回归通过。
- 本地门禁通过；随后在个人 DevCloud testing 环境保留真实请求、回调、Pass/订单/Flow/权益终态证据。

## affected_paths

- `ctl/`
- `trade/`
- `frontend/`（仅在现有页面不能自然消费多个目标时）
- `docs/context/tasks/2026-09-20-pass-cross-sp-modify.md`
- 与变配长期设计对应的正式工程文档（按 change-impact 结果确定）。

## required_context

- `subscription-entitlements`
- `agent-gateway-runtime`
- `commerce-trade-ops`
- `control-plane-ops`
- `personal-devcloud-environment`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@7e907e1a3` | 仓库级安全、Context 与验证规则 | 限定 Task Pack、权限和验证门禁 |
| `ctl/AGENTS.md@7e907e1a3` | CTL 编排和地域权威边界 | 保持同地域并覆盖 CTL 测试 |
| `trade/AGENTS.md@7e907e1a3` | 计费、回调和幂等边界 | 约束报文与回调实现 |
| `frontend/AGENTS.md@7e907e1a3` | 前端 contract 与验证规则 | 仅在需要时改 UI |
| `ai-gateway/AGENTS.md@7e907e1a3` | AI Gateway 发布与数据边界 | 检查权益变化但不触碰发布 |
| `docs/context/domains/subscription-entitlements.md@7e907e1a3` | Pass 与权益真源边界 | 区分交易和权益责任 |
| `docs/context/domains/agent-gateway-runtime.md@7e907e1a3` | AI Gateway/公共路径边界 | 验证 AI 权益和公共链路 |
| `docs/context/project/services/trade.md@7e907e1a3` | Trade 服务上下文 | 约束 provider 与 CTL 调用 |
| `docs/context/project/services/ctl.md@7e907e1a3` | CTL 服务上下文 | 约束实例与地域事实 |
| `.agents/skills/personal-devcloud-environment/SKILL.md@7e907e1a3` | DevCloud testing 安全和验收流程 | 后续真实测试入口 |

## evidence

- 2026-09-20 基线：`modify_policy.go` 仅含两条同 SP 边；Trade 询价和下单仍以 `ErrModifyCrossSubProduct` 拒绝跨 SP。
- 2026-09-20 实现：CTL 新增 `Launch → Launch AI`、`Cruise → Cruise AI`、`Launch → Cruise AI`；Trade 使用目标 category/顶层身份，并在 old/new config 分别写入源、目标 SP/PID/SV。
- 2026-09-20 回调：`checkModify` 与 `modifyResource` 共用双 SP resolver，覆盖跨产品、外层源身份、双侧 PID、内层身份缺失、SV 不匹配和重复匹配的 fail-closed 门禁。
- 2026-09-20 国际 testing 真实回调：跨 SP 下单使用目标 `goodsCategoryId=2025272` 和目标 goodsDetail 顶层身份，但 `checkModify` 回调的 `para.subProductCode` 被计费规范化为源 SP；旧校验误要求外层等于目标，返回 `600803` 并被计费包装为 `700002 rc check failed`。实现已按真实协议改为外层与 `oldConfig` 源身份一致。
- 2026-09-20 国际 `Launch → Launch AI` 真实闭环：Pass `pass-g7o1lr49` 沿用原 resource ID，升级订单 `20260921002021873554901` / Flow `15` 完成；父子任务均 `SUCCESS`，Pass 回到 `active` 且目标为 `bundle_launch_ai_01`，实例保持原 region/pool，AI Gateway 目标 Plan 为 active。
- 2026-09-20 国际跨 SP 退款真实闭环：目标 AI SP 发起 `OnlineRefund` 后，退款订单 `20260921002021873534991` / Flow `16` 完成，`isolateResource(refund)` 成功，`queryFlow status=0`，目标资源变为隔离态，证明该 testing 配置的源/目标 type 退款查询关系可用。该退款不可重试。
- 2026-09-20 国际 `Cruise → Cruise AI`：服务器只返回合法目标 `bundle_cruise_ai_01`，真实 `checkModify` 返回 0；一体化支付最终由计费返回 `100207 / ERR_INSUFFICIENT_BALANCE`，未生成成功升级订单，源 Cruise Pass 保持 `active`。
- 2026-09-20 国际 `Launch → Cruise AI` 备用账号验证：目标 AI SP 已触发真实 `checkModify`，但历史 Pass 的计费归属为 `450860000002 / 1374210036`，当前影子绑定为 `800003280687 / 1374217818`，CTL 正确以 `PASS_MODIFY_CONFIG_MISMATCH` 拒绝；未创建订单，测试实例已暂停后删除。不得通过改 DB 伪造归属继续测试。
- 2026-09-20 新建国际 testing 账号验证：影子绑定可到 `active`，但无 `appId`，不满足 Personal DevCloud 的预置计费账户门禁，未切换环境、未发订单。
- 2026-09-20 国内个人环境：当前 checkout 的完整 localstack 已构建并全部 Running；旧中央 session 已过期，state 中保存的是本地账号凭据而非中央预置账号凭据，回调注册以 401 fail-closed，未发订单。需刷新北京预置实名 testing 登录态后继续三条路径。
- 2026-09-21 国际个人环境恢复验证：当前跨 SP checkout 重新构建后，32 个业务 Pod 均 Running，UIN `800003280687` 的动态回调注册为 active；以新建隔离本地用户 `usr_51be931d3279150bf4ee23df` 发起 Cruise 新购，出站 transaction ID `427259bfcd5693f6762d7be190a798af`。真实 `checkCreate` 已回到个人 Trade 并返回 `returnCode=0`，证明个人回调链路和新购回调协议正常；随后计费 `generateDealsAndPay` 返回 `352005`，原文为 `order cener logic error:call order-center error:can not find appId by 300000001844486`。本地 `trade_order`、`trade_flow`、`ctl.pass` 对该用户均为零行，未落单、未扣费、未创建资源，禁止对该请求盲目重试；该隔离本地用户和 session 已清理，失败请求证据保留在 `evidence.jsonl`。
- 2026-09-21 国际 testing 会话复核：在 Personal DevCloud 私有状态的 10,602 个文件中仅按 session 字段提取到 8 个候选会话，真实 Auth 校验后只有 UIN `800003280687` / AppID `1374217818` 的会话有效；mock UIN `450860000002` 没有可用于续租个人回调路由的中央会话。旧 mock devtunnel agent 已持续返回 `Unauthorized`，说明此前短期 capability/registration 已失效。现存 Cruise 源 Pass `pass-ery75v2j` 与实例 `ins-06232f47d7884f898cc6f3e5f6e13b40` 仍为 `active` / `Running`，可在 mock 路由恢复且余额补足后直接续测，当前不重试支付。
- 2026-09-21 15:04 CST 历史 mock 账号恢复验证：韩国 testing Auth 为既有用户 `usr_29d65f3d3692b2082e6ccbbc` 生成 30 分钟 impersonation 会话，实时 `/auth/shadow/binding` 确认 `450860000002 / 1374210036 / active`；Personal DevCloud 通过标准 `register` 流程重新对齐本地身份并注册动态回调，未部署或修改韩国共享 workload。当前本地用户 `usr_60b0a6ac8262b22da98fccfe` 的 Launch Pass `pass-7re8qtu5` 为 `active`、实例数 0；实时 `modify/bundles` 返回 `Launch → Cruise`、`Launch → Launch AI`、`Launch → Cruise AI` 三条合法目标，其中 `Launch → Cruise AI` 为 `1531 USD`。仅发起一次 `order-and-pay`：真实 `checkModify` 返回 0，`generateDealsAndPay` transaction ID `10c660dad43cf1eb120d2e5155675c66`，计费返回 `100207 / ERR_INSUFFICIENT_BALANCE`，响应中的计费 Deal 为 `20260921002021873634231`。本地未新增 `trade_order` 或 `trade_flow`，Pass 仍为 Launch/active 且无 modify target；未扣费、未发货、未创建资源，禁止重复请求，等待 mentor 补足该 testing mock 账户额度后续测。
- 2026-09-21 新国际 testing 账号询价门禁：新账号 UIN `800003372327` / AppID `1374222764` 已在个人国际环境绑定到三个隔离 E2E 用户，动态回调路由为 active，并保留给 mentor 修复后续测；请求前该账号的 `trade_order=0`、`trade_flow=0`、`ctl.pass=0`。通过正确的个人国际 Trade 入口发起真实新购询价后，HTTP `502`，计费 `qcloud.price.getPrice` 返回 `returnCode=352005`，主线 transaction ID `b110086450369aae91ee86c9ba8475b7`，原文为 `order center error:call order-center error:can not find appId by 300000001844486`。随后用有效 session 经用户入口 `GET /v1/bundles?time_span=1&time_unit=m` 复核，CloudLadder 批量 transaction ID `ecf1ca1824b55ea52bf3a1e0b266d050`，拆单 Launch / Cruise transaction ID 分别为 `5224feb06b26bc1a40680ef722a710ba`、`3f65f8c3e0d5f407b96a86ea0bac6239`，均返回同一 `352005`；网关在 10 秒上游边界返回空体 `502`，而 CTL 日志记录已认证 user ID 并在稍后按无报价降级完成。按账号门禁立即停止，未调用下单或支付；终态仍为 `trade_order=0`、`pending_pay=0`、`trade_flow=0`、`ctl.pass=0`。证据保存在个人环境 `.localstack/personal-devcloud/intl/new-account-800003372327-20260921T043539Z/` 下的 `inquiry-real.json`、`user-inquiry.json`、对应 Trade/CTL/Gateway 日志与 `terminal-state.json`。下一步不是重试订单，而是由计费/订单中心 mentor 确认并开通国际 testing 调用方 AppID `300000001844486`；智研账号状态从“等待中”转为就绪后再从询价重新验收。
- 2026-09-21 国际 `Launch → Cruise AI` 真实闭环：复用 testing mock 计费账户 `450860000002 / 1374210036`，仅发起一笔新订单 `20260921002021873673771`（大单 `20260921002021873673761`，request ID `23b27adb-1084-4b93-8b39-a0bdef858bdd`，transaction ID `399298ea13dab28944b5d50f473eaaf1`）。`checkModify`、`modifyResource`、`queryResource` 全部成功；请求中 `oldConfig` 为通用 Launch（PID `1059132` / `sp_lighthouse_lightvela_bundle_intl`），`newConfig` 为 Cruise AI（PID `1060119` / `sp_lighthouse_lightvela_ai_intl`），目标 CategoryID `2025272`，地域 `region=9 / zone=900001 / Singapore`。终态为 Pass `pass-7re8qtu5 = bundle_cruise_ai_01 / active / modify_flow_id=0`、Trade order `provisioned`、Flow `18 completed`，AI Gateway Cruise AI Plan active、余额 `5000000`。旧余额不足单 `20260921002021873634231` 未清理、未重试，按 testing 规则自然超时。
- 2026-09-21 国际 `Cruise → Cruise AI` 真实闭环：对源 Pass `pass-ery75v2j` 仅新建一笔 `order-and-pay`，订单 `20260921002021873673991`（大单 `20260921002021873673981`，request ID `feb8c13b-1b33-429f-b311-daf86ef8d96d`，transaction ID `5d4109ed1c9371dbc62d7ca27970ab60`）。计费同步下单成功，`modifyResource` 回调携带源 Cruise 通用 SP/PID `sp_lighthouse_lightvela_bundle_intl / 1059132` 与目标 Cruise AI SP/PID `sp_lighthouse_lightvela_ai_intl / 1060119`；后续 `queryResource` 两次均返回 `returnCode=0`、目标 AI SV、`region=9 / zone=900001 / Singapore`。终态为 Trade order `provisioned`、Flow `19 completed`、Pass `bundle_cruise_ai_01 / active / modify_flow_id=0`、`ModifyInstance` 与 `ModifyPass` 均 `SUCCESS`、实例 `ins-06232f47d7884f898cc6f3e5f6e13b40` 仍 `Running`，AI Gateway Cruise AI Plan active、余额 `5000000`。Personal DevCloud 的 Sandbox 外部资源边界使用 `LOCAL.MOCK / region=local`，因此该环境只证明实例编排任务和计费地域保持成功，不能伪称验证了真实新加坡 CVM 的物理规格变化；真实目标规格由计费 AI SV 与 `queryResource` 证明。
- 2026-09-21 国际跨 SP 退款补充闭环：`pass-7re8qtu5` 的 `OnlineRefund` 返回退款单 `20260921002021873748381` / 大单 `20260921002021873748371`，Flow `20 isolate_resource completed`，Pass 终态 `isolated`；`pass-ery75v2j` 的 `OnlineRefund` 返回退款单 `20260921002021873729421` / 大单 `20260921002021873729411`，Flow `21 isolate_resource completed`，`IsolateInstance`、`IsolatePass` 均 `SUCCESS`，实例从 `Running` 变为 `Paused`，Pass 终态 `isolated`。两笔退款均只提交一次且不可重试，证明 Launch/Cruise 两种源套餐跨到目标 AI SP 后均能找到原支付链路并完成退款隔离。
- 2026-09-21 国内 testing 当前账号边界：三条路径均只使用同一个当前智研账号 `330500000005 / 260203940` 的 active shadow binding，并为每个场景新建隔离用户、新购源套餐和新升配订单；未复用历史账号、历史 Pass 或历史成功订单。国内新购报文只含 `bundle_id / period / time_unit`，未携带国际站专用 `auto_renew_flag`。充值前的余额不足旧单保持原状并自然超时，没有清锁或改状态。
- 2026-09-21 国内 `Launch → Launch AI` 真实闭环：隔离用户 `usr_xsp_cn_lla_20260921090035` 新购 Launch 订单 `20260921005023740868171`，生成新 Pass `pass-7re8qtu5`；随后只创建一笔成功升配订单 `20260921005023740955241` / 大单 `20260921005023740955231`，request ID `4a0904ce-fd56-4f2b-8efa-aca338081d34`，transaction ID `44a54c7729eab88edb4f7c84bc6103d5`。真实 `checkModify`、`modifyResource`、`queryFlow`、`queryResource` 均成功，目标为国内 AI SP `sp_lighthouse_lightvela_ai_mc / 1060103`、`region=1 / zone=100001 / 广州`。终态为 Trade order `provisioned`、Flow `6 completed`、CTL task `task-modify-pass-1b00458c4820493acd6e06f9b5c5200f / SUCCESS`、Pass `bundle_launch_ai_01 / active`，AI Gateway `Launch AI / 45,000,000 tokens / active`。计费本单同步返回 `dealDeliverResults.state=2`，暴露出旧代码未把“继续 queryFlow”持久化为 `paid_pending_provision` 的缺陷；新增回归测试后把 `state=2` 与 `state=1` 一并映射为待发货。该单发生在修复镜像部署前，因此仅对这一个已支付单按原始 request body 精确补建本地订单，父任务随后自然重试到终态，没有再次调用计费。
- 2026-09-21 国内 `Cruise → Cruise AI` 真实闭环：隔离用户 `usr_xsp_cn_cca_20260921090035` 新购 Cruise 订单 `20260921005023741187041`，生成新 Pass `pass-g7o1lr49`。第一次升配请求的 `checkModify` 已到当前 UIN 的 DevTunnel，但个人环境 `18084` kubectl port-forward 瞬时 EOF，计费包装为 `700002 / 410502`；DB 证明未生成 Deal/Flow 且 Pass 仍为 Cruise/active。仅重启个人回调 port-forward 并以无副作用非法报文验证稳定返回后，新建升配订单 `20260921005023741191421` / 大单 `20260921005023741191411`，request ID `5c2a1423-acc1-4f42-94de-8956d3c94576`，transaction ID `f406b29c70ad469b379cdf9faf4536c4`。真实回调携带源 `sp_lighthouse_lightvela_mc / 1059119`、目标 `sp_lighthouse_lightvela_ai_mc / 1060103` 和原地域 `region=1 / zone=100001`；计费同步返回 `state=1`，修复后的 Trade 自动落单，无手工补行。终态为 order `provisioned`、Flow `8 completed`、task `task-modify-pass-b6c4ad77a24d441067dccd82b2ee7861 / SUCCESS`、Pass `bundle_cruise_ai_01 / active`，AI Gateway `Cruise AI / 100,000,000 tokens / active`。
- 2026-09-21 国内 `Launch → Cruise AI` 真实闭环：隔离用户 `usr_xsp_cn_lca_20260921090035` 新购 Launch 订单 `20260921005023741233201`，生成新 Pass `pass-ery75v2j`；实时目标列表同时返回 `Launch → Cruise`、`Launch → Launch AI`、`Launch → Cruise AI`，只提交最后一条。升配订单 `20260921005023741270161` / 大单 `20260921005023741270151`，request ID `3cd97e2e-220f-448b-8ab9-9059bc390270`，transaction ID `9cbe91e552916c4eb5fd0b4ad4989052`；`modifyResource` 明确携带源通用 SP/PID `sp_lighthouse_lightvela_mc / 1059119` 与目标 AI SP/PID `sp_lighthouse_lightvela_ai_mc / 1060103`，地域保持 `region=1 / zone=100001`。计费同步返回 `state=1`，Trade 自动落单；终态为 order `provisioned`、Flow `11 completed`、task `task-modify-pass-57ac509e673cde82f73b0b08d34bfa43 / SUCCESS`、Pass `bundle_cruise_ai_01 / active`，AI Gateway `Cruise AI / 100,000,000 tokens / active`。
- 2026-09-21 国内跨 SP 退款闭环：三笔目标 AI Pass 均只发起一次 `OnlineRefund`。`pass-g7o1lr49` 返回退款单 `20260921005023741177751` / 大单 `20260921005023741177741`，Flow `9 isolate_resource completed`；`pass-ery75v2j` 返回退款单 `20260921005023741199141` / 大单 `20260921005023741199131`，Flow `12 isolate_resource completed`；`pass-7re8qtu5` 返回退款单 `20260921005023741181981` / 大单 `20260921005023741181971`，Flow `13 isolate_resource completed`。三笔 Pass 最终分别保持目标 `Launch AI / Cruise AI / Cruise AI` bundle 身份并进入 `isolated`，证明国内源/目标 type 的退款查询关系已真实可用。
- 2026-09-21 最终门禁：Trade 询价/下单/`checkModify`/`modifyResource`/internal API 的 test、vet、race 通过；CTL Pass/worker/实例 worker 的 test、vet、race 通过；Sandbox provider 通过；前端订阅页 53 条通过；国内跨 SP seed、完整 localstack validate、Personal DevCloud contract、文档系统、change-impact 和 `git diff --check` 全部通过。变更仍只保留在隔离分支，未 commit、push、创建 MR、部署共享环境或生产。
- 2026-09-22 国际短期 capability 路径重新验收：使用合法 international testing 账号 `450860000023 / 1374222817` 和个人用户 `usr_b3496462bba969391ebc2976`，registration/capability 均为 active，个人 Trade 不持有 Jifei AppSecret 或 CloudLadder HMAC。`Launch → Launch AI` 订单 `20260922023021873979561` / 大单 `20260922023021873979551`，`checkModify` event `14972257`、`modifyResource` event `61420692`、Flow `14 completed`，父任务 `task-modify-pass-b39687afbc127a334baa8da9d4853619` 和子任务 `task-b471f1c96b03439d8fb2a043fa04f0d2` 均 `SUCCESS`；Pass `pass-ery75v2j`、实例 `ins-477e2dcbb6b245539849076cb8e0a775` 和 Launch AI subscription 到终态。退款单 `20260922023021873942721`、Flow `15` 完成，用户删除后 Flow `16 destroy_resource completed`，`history_pass=deleted`、实例已删除。
- 2026-09-22 国际 `Launch → Cruise AI` 重新验收：新购 `20260922023021873915181` 生成 `pass-165cur9j` 与实例 `ins-2248871f5a7240bb8fc90212126a0f44`；实时询价 HTTP 200，三个目标按 `Cruise / Launch AI / Cruise AI` 策略顺序返回。升配订单 `20260922023021873931181` / 大单 `20260922023021873931171`，`checkModify` event `97882503`、`modifyResource` event `35413514`、Flow `18 completed`，父任务 `task-modify-pass-adb360f0be0124f9c05daecad1aed837` 与子任务 `task-e19135d175db44aaa24bbe40ca6bb878` 均 `SUCCESS`；Pass 为 Cruise AI/active、实例 Running，地域保持 `region=9 / zone=900001`。退款单 `20260922023021873961401` / 大单 `20260922023021873961391`、Flow `19 isolate_resource completed`；用户删除后 Flow `20 destroy_resource completed`、`history_pass=deleted`、实例终态 Deleted。
- 2026-09-22 国际 `Cruise → Cruise AI` 重新验收：Cruise 新购的 transaction `ba35e36f9e0afff30877934788a50978` 在 CloudLadder 10 秒边界返回 504，但真实 `checkCreate` event `19594093` 与 `createResource` event `30773609` 已到达，随后重投 event `95838974` 幂等成功，生成 active Pass `pass-pxqv9d45`；因此没有重试下单。新建实例 `ins-a66a1023105c4370940936dafe9f8164` 后，询价只返回 `bundle_cruise_ai_01`，升配订单 `20260922023021873961701` / 大单 `20260922023021873961691`，`modifyResource` event `77137665`、Flow `23 completed`，父任务 `task-modify-pass-3a3c16198ad379ea8bd9b367b15edcf5` 与子任务 `task-81caab054cb6459eaa128745811229c3` 均 `SUCCESS`。回调明确保留 `region=9 / zone=900001`，源为 `sp_lighthouse_lightvela_bundle_intl / 1059132`，目标为 `sp_lighthouse_lightvela_ai_intl / 1060119`；`queryResource` event `52344590` 返回 Cruise AI SV 与 Singapore。AI Gateway subscription `129f6213-1fcd-45e5-9e1a-0d466f82993c` 为 Cruise AI/active/5,000,000 tokens。退款单 `20260922023021873931831` / 大单 `20260922023021873931821`、Flow `24 completed`；用户删除后 Flow `25 completed`、Pass 进入 `history_pass=deleted`、实例终态 Deleted。
- 2026-09-22 运行时修复验证：旧 CTL 串行三目标询价会把外部延迟叠加，且单目标 15 秒边界可使整条请求失败；当前实现改为三个目标并行、单目标 20 秒预算、结果仍按策略顺序返回，配合 Service Gateway `ctl-passes=30s`。个人国际环境连续三次公开网关询价分别耗时 `3.030873s / 7.479472s / 2.670743s`，均 HTTP 200。Linux localstack 的 port-forward 改由 supervisor 监护；浏览器 nonce server 改为线程化、原子消费并限制半连接 2 秒，避免单个残缺连接阻塞登录。注销后旧 capability 探针返回 401，registration 保留 disabled tombstone，`down` 已停止个人工作负载并保留 PVC。
- 2026-09-22 国内短期 capability 路径重新验收：使用北京 testing 账号 `700000164995 / 251202221`、中央用户 `usr_a91666c074db49d452e19c26` 和个人用户 `usr_56b7a1e4c0c8d1ea6e010c1c`；`status` readiness 穿透个人 Trade、中央 Auth 和中央 Trade 返回 `200 + {"code":"OK","message":"ready"}`，个人 Trade 不持有 Jifei AppSecret、CloudLadder HMAC 或 SOPS/age identity。`Launch → Launch AI` 新购订单 `20260922995023753443741` / 大单 `20260922995023753443731` 生成 `pass-6bsug0a1`，升配订单 `20260922995023753464011` / 大单 `20260922995023753464001` 到 `modify_resource completed`，Pass 回到 `bundle_launch_ai_01 / active`；退款单 `20260922995023753651781` / 大单 `20260922995023753651771` 完成 `isolate_resource`，AI subscription 取消。用户销毁请求早先在旧个人 Trade 配置下只把 Pass 推进到 `deleting` 且下游返回 404；确认计费未重复受理后，仅补发一次原销毁链路缺失的 `ModifyResourceStatus(PRE_DESTROY)`，最终 `destroy_resource completed`、`history_pass=deleted`，没有重放用户退款或销毁请求。
- 2026-09-22 国内 `Cruise → Cruise AI` 短期 capability 重新验收：Cruise 新购订单 `20260923995023754868631` / 大单 `20260923995023754868621` 生成 `pass-7re8qtu5`；升配订单 `20260923995023754928341` / 大单 `20260923995023754928331`，request ID `f48f9dd6-9a91-4eaa-9fc8-2faf59a75d41`，transaction ID `2ddbb5da98be57362d634921470dbcc9`，`checkModify` event `32647356`、`modifyResource` event `21781914`。终态为 order `provisioned`、Flow `6 modify_resource completed`、任务 `task-modify-pass-1b00458c4820493acd6e06f9b5c5200f / SUCCESS`、Pass `bundle_cruise_ai_01 / active / modify_flow_id=0`。退款只提交一次，返回 `20260923995023754952341` / 大单 `20260923995023754952331`，Flow `7 isolate_resource completed`、IsolatePass `SUCCESS`、Pass `isolated`；用户销毁只提交一次，Flow `8 destroy_resource completed`、DestroyPass `SUCCESS`、活表行消失且 `history_pass=deleted`。
- 2026-09-22 国内 `Launch → Cruise AI` 短期 capability 重新验收：全新 Launch 新购订单 `20260923995023754923591` / 大单 `20260923995023754923581` 生成 `pass-g7o1lr49`，order `provisioned`、Flow `9 create_resource completed`。实时询价按策略顺序返回 `Cruise / Launch AI / Cruise AI`，目标 Cruise AI 差价 `15800 CNY`；升配订单 `20260923995023755007681` / 大单 `20260923995023755007671`，request ID `9433721b-8073-4dbf-95fb-84086c786bf0`，transaction ID `7da0a369ea85f36ff9dc71750ab8120a`，`checkModify` event `67054365`、`modifyResource` event `87928062`。终态为 order `provisioned`、Flow `10 modify_resource completed`、任务 `task-modify-pass-c9e35b529aca947457a1fcfc2a634c00 / SUCCESS`、Pass `bundle_cruise_ai_01 / active / modify_flow_id=0`、`OPENCLAW_INSTANCE=1/1`，AI Gateway subscription `2e9c73f2-f0b8-4ed0-8450-dcf7a143fcee` 为 `active / 100000000 tokens`。退款只提交一次，返回 `20260923995023755050091` / 大单 `20260923995023755050081`，Flow `11 isolate_resource completed`、Pass `isolated`、AI subscription `cancelled`；用户销毁只提交一次，Flow `12 destroy_resource completed`、DestroyPass `SUCCESS`、活表行消失且 `history_pass=deleted`。
- 2026-09-22 国内个人环境清理门禁：registration 已变为 `disabled` 且保留 tombstone，脚本用旧 billing capability 验证中央代理返回 `401`；heartbeat、devtunnel-agent、browser bootstrap 均停止，`5173/8085/18084/48084/29010/29040` 全部释放，业务 Deployment/StatefulSet/Job 已删除，只保留 kind 自身 `coredns` 与 `local-path-provisioner` 以及 PVC 数据。
- 2026-09-20 本地验证：Trade 受影响包、vet、race；CTL Pass/worker/实例 worker、vet、race；Sandbox provider；前端订阅页 53 条用例；localstack/Personal DevCloud contract；文档系统校验和 `git diff --check` 均通过。完整 Trade 仅剩基线可复现的 `cloudbillingclient` 两条签名测试失败，CTL 全量受既有 lightginkgo 配置和 rootless Docker 前置阻塞。

## risks

- 旧实现让 `oldConfig`/`newConfig` 共用 SP/PID，直接放开门禁会生成错误计费报文。
- 回调若只在目标 SP 内反解两边套餐，会找不到源套餐或误匹配。
- 跨 SP 完成后退款使用目标 AI SP；国际 testing 的 Launch、Cruise 源套餐均已证明源/目标 type 查询关系可用，但国内及其它站点仍须把各自计费配置和真实退款验证作为上线门禁。
- 通用套餐此前可能没有 AI Gateway subscription，不能只复用“更新已有 AI 套餐”的逻辑。

## validation

- `cd ctl && go test ./pkg/logic/pass ./pkg/pass/worker ./pkg/taskruntime/common ./pkg/instance/worker`
- `cd ctl && go vet ./pkg/logic/pass ./pkg/pass/worker ./pkg/taskruntime/common ./pkg/instance/worker`
- `cd ctl && go test -race ./pkg/logic/pass ./pkg/pass/worker`
- `cd trade && go test/go vet` 受影响包，并对询价、下单、`checkModify`、`modifyResource` 跑 race。
- `cd sandbox && GOWORK=off go test ./internal/provider`
- `cd frontend && pnpm vitest run next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx`
- `bash deploy/localstack/tests/validate.sh`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format text`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-files-file <(git diff --name-only)`
- `git diff --check`
- DevCloud `status`、跨 SP 真实询价/下单/回调/终态证据；未支付时不得宣称发货闭环。

## decisions

- 只新增通用 SP → AI SP 的三条有向边；同 SP 逻辑保持原样。
- old/new 配置必须各自完整自描述，不从外层或另一侧推断。
- 跨地域在支付前拒绝；退款关联由计费外部 authority 配置并作为真实验收门禁。

## scan_scope

- `ctl/pkg/logic/pass`
- `trade/internal/{logic,jifei,bundleresolve}`
- AI Gateway entitlement 调用链及相关测试。

## scan_output

- 当前不生成独立扫描产物；证据记录在本 Task Pack。

## handoff

- 隔离分支 `codex/lightvela-cross-sp-modify` 已完成源码、文档和本地门禁；国内、国际的 `Launch → Launch AI`、`Launch → Cruise AI`、`Cruise → Cruise AI` 三条新增路径均已在个人 DevCloud 通过真实 testing 计费下单、支付、`checkModify`、`modifyResource`、`queryFlow`、`queryResource`、Trade/Pass/CTL Task/AI Gateway 终态验证，并覆盖跨 SP `OnlineRefund → isolateResource`。国内三条路径严格使用当前账号 `330500000005 / 260203940` 下的全新用户、全新源 Pass 和全新订单；旧未支付 testing 单保持不动并自然超时。个人 Sandbox 使用本地外部资源替身，不能替代共享 testing/生产真实 CVM 的物理规格验证，该边界已单独记录。当前未 commit、push、创建 MR、部署共享环境或生产。
