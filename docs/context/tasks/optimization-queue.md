# 优化需求队列

更新时间：2026-10-03。此文件是队列状态的记录；每个优化点在独立分支实现。同一时刻最多一个 `active`；`pending_user` 可暂存多个，统一从 TAPD 看板「待确认」分组回溯。

## 队列规则

1. 新需求按收到顺序追加到队尾，并分配稳定 ID 和独立分支；仅用户明确指定极特殊插队时调整处理顺序，记录原因。
2. 队首从 `queued` 进入 `active` 后，只在该分支排查、实现和验证。同一时刻最多一个 `active`。需要用户决定产品规则或外部配置时，先完成所有独立可做的工作，再在卡片描述开头标出具体问题、恢复条件，新增流转评论并移至 `pending_user`；释放处理槽位，后续项可继续。`pending_user` 仍是未完成需求，不因暂存而标记 `done`。
3. 每项本地完成后，按项目规范在同一独立分支提交并推送预览，记录实际预览地址与验收结果；完成提交前 CR，修复发现的问题并复验；准备指向 `master` 的 MR 标题、描述和验证证据。把预览、CR、MR 草稿与剩余风险写入卡片流转评论，向用户汇总；状态为 `pending_user`，等用户确认后创建 MR。MR 创建后按项目规范继续 Fanny 与负责人 CR。创建 MR 前不得宣称这两项已完成。
4. 用户回复暂存项时，先核对该卡片和当前处理槽；如果已有另一项 `active`，将获回复的项排为下一个处理项，除非用户明确要求插队。用户确认后的 MR 操作及后续评审完成才标记 `done`；发现外部依赖导致不能继续时记录证据与阻塞条件，不把未解决项默默跳过。
5. 队列文件记录需求和状态；每项的代码、测试、任务记录都留在对应分支。Git 与发布操作仍遵守仓库 `AGENTS.md` 的确认要求；用户本次已明确要求推送预览，创建 MR 仍需等待本项汇总后的确认。
6. 每个优化需求对应「Vela体验优化」TAPD 轻协作项目 `70234090` 的一张需求卡。入队时建卡并放入「待优化」；开始处理移至「进行中」；需要用户决策或外部条件时移至「待确认」并写明问题；MR 创建后待 Fanny/owner CR 与预览验收时移至「待验收」；所有交付与验收完成后移至「已完成」，同时把 TAPD 原生状态从 `open` 改为 `done`。每次流转均同步卡片分组、描述、评论、队列文件和会话进度；TAPD 看板的「待确认」分组是用户统一回溯入口，不以本文件替代。
7. 每次卡片流转都新增评论，记录本次阶段、已完成事项、验证证据、未完成项和下一步。进入「待确认」且 MR 已准备时，评论必须写明拟定 MR 标题、源/目标分支、最新提交、预览地址、CR 结果、测试结果、剩余风险以及待用户确认的具体操作；MR 创建后再追加真实 MR 链接，不把草稿表述成已提交。

## 协作看板

- [统一回溯入口：TAPD 优化看板](https://tapd.woa.com/tapd_fe/t/index/70234090)；进入「待确认」分组查看所有需用户回复的需求（用户提供的带 `query_token` 链接仅用于访问，不写入仓库）。
- 分组：「待优化」「进行中」「待确认」「待验收」「已完成」。看板原生状态只有 `open`/`done`，中间阶段由分组表达。
- [OPT-001 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685577)：`1070234090138685577`，当前「待验收」，MR [!4775](https://git.woa.com/wisp/mono2/-/merge_requests/4775)。
- [OPT-002 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685578)：`1070234090138685578`，当前「待确认」。
- [OPT-003 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685610)：`1070234090138685610`，当前「待验收」，MR [!4776](https://git.woa.com/wisp/mono2/-/merge_requests/4776)。
- [OPT-004 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685615)：`1070234090138685615`，当前「待确认」，按用户决定挂起，等待真实订单查询接口。
- [OPT-005 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685654)：`1070234090138685654`，用户指定插队，当前「待确认」。
- [OPT-006 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138690655)：`1070234090138690655`，当前「待验收」，MR [!4774](https://git.woa.com/wisp/mono2/-/merge_requests/4774)。
- [OPT-007 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138696615)：`1070234090138696615`，当前「待验收」，MR [!4850](https://git.woa.com/wisp/mono2/-/merge_requests/4850)。
- [OPT-008 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138709055)：`1070234090138709055`，调查完成，当前「待确认」治理范围。
- [OPT-009 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138744537)：`1070234090138744537`，当前「待确认」，流转评论 `1070234090217814055`；待确认提交与推送预览。

## 需求清单

| ID | 需求 | 状态 | 独立分支 | 验收目标 | 下一步 |
|---|---|---|---|---|---|
| OPT-001 | Review `/subscribe` 页“首月 6 折”等优惠标签展示逻辑 | `awaiting_review` | `frontsandbox/subscribe-promotion-badge-20260929` | 有真实适用优惠时显示“免费”或实际折扣；无适用优惠时不显示促销标签 | [MR !4775](https://git.woa.com/wisp/mono2/-/merge_requests/4775) 已合入 master；等待用户反馈 CR 结果与真实报价验收 |
| OPT-002 | 微信快捷登录在弹窗内完成授权，展示快捷登录按钮或待扫描二维码 | `pending_user` | `frontsandbox/wechat-login-in-modal-20260929` | 弹窗内嵌微信授权；确认后允许当前页回跳 | 已提交推送，双站预览 200、CR 与 MR 草稿就绪；真实微信客户端验收需同站部署 Auth 后端；待确认创建 MR |
| OPT-003 | `/subscribe` 套餐卡强调外框随 Hover 移动 | `awaiting_review` | `frontsandbox/subscribe-card-hover-border` | 鼠标移入任一卡片时强调该卡；移出全部卡片后不固定强调某张卡 | [MR !4776](https://git.woa.com/wisp/mono2/-/merge_requests/4776) 已合入 master；等待用户反馈 CR 结果与真实设备视觉验收 |
| OPT-004 | `/account/billing/` 展示已有订单列表 | `pending_user`（挂起） | `frontsandbox/account-billing-order-list` | 将当前账号真实订单作为独立区块置于「订阅套餐」大卡片下方 | 用户确认真实订单查询接口缺失时先挂起；不展示演示订单或空列表。调查及挂起文档提交 `d25332100` 已推送；尚无实现/预览/MR |
| OPT-005 | `/subscribe/` 套餐售罄交互与「需求加急」 | `pending_user`（用户指定插队） | `frontsandbox/subscribe-soldout-urgent` | 国内外付费卡保留灰显价格和功能点，售罄 CTA 改为加急反馈；国际站联系入口为 Discord；售罄绝不进入下单 | 已提交推送、CR 与 MR 草稿就绪；双站预览 200，待确认创建 MR |
| OPT-006 | 国内、国际站移动端首页左下角出现字面量 `\n` | `awaiting_review` | `frontsandbox/mobile-stray-escape-20260929` | 双站首页页脚下方不再显示转义符；重新导入静态首页素材不会复发 | 已合入最新 master 并提交 [MR !4774](https://git.woa.com/wisp/mono2/-/merge_requests/4774)，最新 `2e01ff7d0`；等待 Fanny、负责人 CR 和移动端视觉验收 |
| OPT-007 | 创建 Agent 页「建议」卡片可横向滚动查看更多选项 | `awaiting_review` | `frontsandbox/agent-onboarding-suggestions-scroll-20260929` | 鼠标滚轮、按钮、触控板和触屏可到达全部建议卡片；点击卡片仍可选模板 | 已创建 [MR !4850](https://git.woa.com/wisp/mono2/-/merge_requests/4850)，需求分支已同步最新 master 并复验、双站预览 200；等待 CR 与登录态视觉验收，尚未合并或发布 |
| OPT-008 | “测试运行”临时任务残留并继续消耗 Token | `pending_user`（调研完成） | `frontsandbox/automation-test-task-cleanup-20260930` | 新测试不会重复执行；旧版残留可安全识别并清理；异常中断有兜底且清理失败可见 | 最新 master 的 `in 2m` 修复只防止新增；调查与治理方案见 Task Pack。待确认是否实施存量止损与持久清理；尚无代码实现/预览/MR |

| OPT-009 | Chat 首屏等待文案与可爱小助理图案/动效 | `pending_user` | `frontsandbox/chat-friendly-loading-20261003` | 功能提交2bfd749a5已推送；双站Chat预览200且资源含新文案，115聚焦/check/双站构建/CR通过；全量测试未通过，待确认创建MR | 用户已确认提交并推送预览；本地验证已完成，正在提交、推送并核对双站分支预览 |

## 当前处理项

| ID | 需求 | 状态 | 独立分支 | 下一步 |
|---|---|---|---|---|
| OPT-009 | Chat 首屏小助理加载状态 | `pending_user` | 功能提交2bfd749a5已推送；双站Chat预览200且资源含新文案，115聚焦/check/双站构建/CR通过；全量测试未通过，待确认创建MR | 用户已确认提交并推送预览，正在核对双站分支产物 |

## 待确认（看板统一回溯）

| ID | 卡片 | 需用户决定 | 恢复条件 |
|---|---|---|---|
| OPT-002 | [微信登录弹窗](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685578) | 是否创建 `frontsandbox/wechat-login-in-modal-20260929` → `master` MR | 双站预览已返回 200；用户确认后创建 MR；真实扫码验收需同站 Auth 部署与微信客户端 |
| OPT-004 | [账单页订单列表](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685615) | 用户已决定挂起 | 真实订单查询接口具备账号隔离、状态、最终实付金额和分页能力后恢复；不能展示演示订单或假空列表 |
| OPT-005 | [售罄加急交互](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685654) | 是否创建 `frontsandbox/subscribe-soldout-urgent` → `master` MR | 双站预览已返回 200；用户确认后创建 MR；完整信息见卡片评论 |
| OPT-008 | [测试运行任务残留](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138709055) | 是否按报告实施存量旧周期测试任务止损和持久清理 | 确认治理范围；生产实例盘点/暂停/删除需另行明确授权与影响范围。当前仅有调查文档，无代码实现/预览/MR |

## 待验收

| ID | 卡片 | MR | 后续 |
|---|---|---|---|
| OPT-001 | [订阅页促销标签](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685577) | [!4775](https://git.woa.com/wisp/mono2/-/merge_requests/4775) | 已合入 master；等待用户反馈 CR 结果与登录后真实报价验收，发布状态未核实 |
| OPT-003 | [套餐卡 Hover 外框](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685610) | [!4776](https://git.woa.com/wisp/mono2/-/merge_requests/4776) | 已合入 master；等待用户反馈 CR 结果与真实设备视觉验收，发布状态未核实 |
| OPT-006 | [移动端首页转义符](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138690655) | [!4774](https://git.woa.com/wisp/mono2/-/merge_requests/4774) | 已合入 master；Fanny、负责人 CR 与移动端视觉验收待核实，发布状态未核实 |

| OPT-007 | [创建 Agent 建议卡片滚动](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138696615) | [!4850](https://git.woa.com/wisp/mono2/-/merge_requests/4850) | 需求分支已同步最新 master 并复验、双站预览 200；CR 与登录态视觉验收待完成，尚未合并或发布 |

| OPT-009 | [Chat 小助理加载状态](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138744537) | [!4947](https://git.woa.com/wisp/mono2/-/merge_requests/4947) | MR已创建，可合并；待Fanny/负责人CR与登录态验收，尚未合并或发布 |

## 等待队列（FIFO）

| 顺位 | ID | 需求 | 状态 | 独立分支 | 进入条件 |
|---|---|---|---|---|---|
| — | — | 当前无尚未启动的新需求；OPT-004 挂起 | — | — | 需用户回复的 OPT-002、005、008、009 暂存待确认；当前无 active |

## 处理记录

- 2026-09-29：按用户给出的顺序入队 OPT-001、OPT-002；分别创建独立本地分支。取出 OPT-001，OPT-002 保持排队。
- 2026-09-29：OPT-001 本地修复完成；双站聚焦测试 106/106、i18n 检查、类型检查、生产构建通过。全量 Vitest 运行约 4 分钟后单 worker 持续占用 CPU 且无汇总，已停止；详见该分支 Task Pack。出队 OPT-001，取出 OPT-002 开始依赖调研。
- 2026-09-29：OPT-002 调研完成；微信官方支持弹窗内嵌授权，现有后端仅提供跳转型 OAuth start/callback。是否允许授权确认后当前页回跳会决定后端改造范围，状态改为 `pending_user`；队列暂停出队。
- 2026-09-29：用户确认允许扫码/快捷登录确认后当前页回跳；OPT-002 恢复 `active`，按现有回调链路实现。
- 2026-09-29：OPT-002 本地实现完成；Auth 全量 Go 测试、前端聚焦测试 105/105、类型检查、i18n、生产构建、文档与 change impact 检查通过。未做真实微信客户端验收，需部署预览环境后验证；队列当前无待处理项。
- 2026-09-29：用户补充逐项交付规则：每项需先推送预览并记录地址、完成提交前 CR、准备 MR，再汇总给用户确认。纠正此前将 `done_local` 视为出队的规则；OPT-001 恢复为当前项，OPT-002 等待交付顺位。
- 2026-09-29：OPT-001 推送至 `frontsandbox/subscribe-promotion-badge-20260929`。预览地址为 `https://subscribe-promotion-badge-20260929.preview.lightclaw.tech/subscribe` 与 `https://intl-subscribe-promotion-badge-20260929.preview.lightclaw.tech/subscribe`；首次访问均返回 404，尚未完成预览验收。提交前 CR 无阻断项，MR 草稿见该项 Task Pack。
- 2026-09-29：OPT-001 双站预览随后均返回 200，且各自页面资源与 `master` 的资源不同，分支产物已发布。状态转为 `pending_user`，等待确认创建 MR；OPT-002 继续排队。
- 2026-09-29：按用户要求配置 TAPD MCP，核实项目 `70234090` 为「Vela体验优化」；建立五个流程分组，创建 OPT-001/OPT-002 两张卡片并分别流转至「待确认」/「待优化」。未来需求在每一阶段显式更新卡片。
- 2026-09-29：按用户补充要求，OPT-001 的「待确认」流转评论 `1070234090217529305` 写入 MR 提交准备详情；OPT-002 的「待优化」评论 `1070234090217529319` 写入入队与依赖信息。此后每次流转都在对应卡片评论留痕。
- 2026-09-29：用户允许需确认的需求暂存在看板「待确认」，释放处理槽位；统一从看板回溯。OPT-001 保持待确认且未创建 MR，OPT-002 仍排队但可作为下一项继续。
- 2026-09-29：用户追加 OPT-003 套餐卡 Hover 外框需求。创建 TAPD 卡片 `1070234090138685610`，放入「待优化」并写入入队评论 `1070234090217529420`；按 FIFO 排在 OPT-002 之后。独立本地分支 `frontsandbox/subscribe-card-hover-border` 已从 `origin/master` 提交 `63d1850f6` 创建，卡片补充评论 `1070234090217529426` 已记录；尚未实施或推送。
- 2026-09-29：用户追加 OPT-004 账单页订单列表需求。创建 TAPD 卡片 `1070234090138685615`，放入「待优化」并写入入队评论 `1070234090217529445`；按 FIFO 排在 OPT-003 之后。独立本地分支 `frontsandbox/account-billing-order-list` 已从 `origin/master` 提交 `63d1850f6` 创建，卡片补充评论 `1070234090217529448` 已记录；尚未实施或推送。
- 2026-09-29：用户明确要求插入 OPT-005，直接按 ZIP 的已确认国内站售罄设计实施，优先于 OPT-002—004。创建 TAPD 卡片 `1070234090138685654` 并移入「进行中」，流转评论 `1070234090217529622` 记录插队原因和范围；独立本地分支 `frontsandbox/subscribe-soldout-urgent` 从 `origin/master` 提交 `63d1850f6` 创建。ZIP 中正式设计、图和源码快照与仓库现有文件相同，运行代码尚未实现。
- 2026-09-29：用户补充 OPT-005 国际站联系入口改为 Discord，并要求其余需求在上午检查前至少推进至待确认。OPT-005 国内外实现、聚焦测试 105/105、check、双站构建和提交前 CR 完成；预览分支最新 `725ac0f3c` 已推送，两站 URL 暂为 404。卡片移至「待确认」，评论 `1070234090217538012` 记录 MR 草稿、验证与预览状态。按 FIFO 取出 OPT-002，卡片移至「进行中」并评论 `1070234090217538184`。
- 2026-09-29：OPT-005 双站预览随后均返回 200，且页面资源与 master 不同；卡片补充评论 `1070234090217539587`。预览：`https://subscribe-soldout-urgent.preview.lightclaw.tech/subscribe`、`https://intl-subscribe-soldout-urgent.preview.lightclaw.tech/subscribe`。
- 2026-09-29：OPT-002 分支 `frontsandbox/wechat-login-in-modal-20260929` 最新 `4ebde14f2` 已推送；前端聚焦测试 105/105、check、国内站构建、CR 通过。双站预览返回 200 且资源与 master 不同：`https://wechat-login-in-modal-20260929.preview.lightclaw.tech/`、`https://intl-wechat-login-in-modal-20260929.preview.lightclaw.tech/`。看板移至「待确认」，评论 `1070234090217540000`、`1070234090217541389` 记录 MR 草稿与预览。真实扫码仍需同站部署 Auth 服务和微信客户端验收。
- 2026-09-29：OPT-003 分支 `frontsandbox/subscribe-card-hover-border` 最新 `b2dc56c96` 已推送；聚焦测试 44/44、check、双站构建、CR 通过。看板移至「待确认」，评论 `1070234090217541821` 记录 MR 草稿；预览 `https://subscribe-card-hover-border.preview.lightclaw.tech/subscribe`、`https://intl-subscribe-card-hover-border.preview.lightclaw.tech/subscribe` 当前仍返回 404，未完成线上预览验收。
- 2026-09-29：OPT-004 发现隐藏订单页使用 5 条写死演示数据，前端/后端均无当前账号订单历史接口。独立分支 `frontsandbox/account-billing-order-list` 推送调查 Task Pack 提交 `6f4c4bac2`；尚未更改用户页面。卡片移至「待确认」，流转评论 `1070234090217542037` 写明两种范围选择及恢复条件。该项没有预览、CR、MR 草稿，不能称为已交付。
- 2026-09-29：OPT-003 双站预览转为 HTTP 200，且各自页面 JS 资源集与 master 预览不同；卡片补充评论 `1070234090217542126`。国内站 `https://subscribe-card-hover-border.preview.lightclaw.tech/subscribe`，国际站 `https://intl-subscribe-card-hover-border.preview.lightclaw.tech/subscribe`。
- 2026-09-29：用户追加 OPT-006 双站移动端首页左下角字面量 `\n` 问题；TAPD 卡片 `1070234090138690655` 入「待优化」后因处理槽空闲立即流转「进行中」，入队与开始评论 `1070234090217551802`、`1070234090217551810`。独立分支 `frontsandbox/mobile-stray-escape-20260929` 从最新 master `96d19592f` 创建。生产双站 HTML 与 9 个 locale 片段均有该尾部字面量；已修复片段和导入脚本，聚焦测试 1/1、check、双站构建通过；完整相关套件 64/67，3 个既有 PNG→WEBP 预期失败记录在本项 Task Pack。
- 2026-09-29：OPT-006 提交前 CR 无阻断，变更影响检查通过，MR 草稿已写入 Task Pack；独立分支提交 `dacd70543` 已推送。预览地址为 `https://mobile-stray-escape-20260929.preview.lightclaw.tech/` 与 `https://intl-mobile-stray-escape-20260929.preview.lightclaw.tech/`，首次检查均返回 404，继续等待预览发布并核对移动端。
- 2026-09-29：OPT-006 双站预览随后均返回 HTTP 200；各自首页 HTML 的字面量 `\\n` 计数为 0，master 预览均为 1。分支最新 `fd47e50af` 已推送，卡片移至「待确认」，流转评论 `1070234090217553648` 写明 MR 标题、分支、预览、CR、测试和剩余验收条件；尚未创建 MR。
- 2026-09-29：用户授权提交 OPT-006 MR。分支已合入最新 master `c1df25f86`，聚焦测试复验通过，最新 `2e01ff7d0` 推送；工蜂创建 [MR !4774](https://git.woa.com/wisp/mono2/-/merge_requests/4774)，状态 `opened`、可合并、提交检查成功。TAPD 移至「待验收」，评论 `1070234090217557669` 记录真实 MR 与剩余 CR/验收；尚未合并或发布。
- 2026-09-29：用户授权提交 OPT-001 和 OPT-003 MR。先处理 OPT-001：合入最新 master，国内与国际订阅页聚焦测试复验 106/106，分支提交 `17977dd6c` 推送；工蜂创建 [MR !4775](https://git.woa.com/wisp/mono2/-/merge_requests/4775)，状态 `opened`、可合并、提交检查成功。TAPD 移至「待验收」，评论 `1070234090217561584` 记录真实 MR 与剩余评审；尚未合并或发布。随后处理 OPT-003。
- 2026-09-29：OPT-003 合入最新 master，套餐卡聚焦测试复验 44/44，提交 `a933cf499` 推送；工蜂创建 [MR !4776](https://git.woa.com/wisp/mono2/-/merge_requests/4776)，状态 `opened`、可合并、提交检查成功。TAPD 移至「待验收」，评论 `1070234090217561756` 记录真实 MR 与剩余评审；尚未合并或发布。
- 2026-09-29：用户确认 OPT-004 在真实订单查询接口缺失时先挂起；TAPD 卡片保持「待确认」，描述与评论 `1070234090217575311` 写明恢复条件。分支 Task Pack 本地提交 `d25332100`，Git 凭据缺失导致推送失败，卡片评论 `1070234090217575621` 已如实记录。页面未改动。
- 2026-09-29：用户追加 OPT-007 创建 Agent 页「建议」卡片横向滚动需求；TAPD 卡片 `1070234090138696615` 入「待优化」后因处理槽空闲立即流转「进行中」，入队评论 `1070234090217575836`。独立分支 `frontsandbox/agent-onboarding-suggestions-scroll-20260929` 从本地 `origin/master@c1df25f86` 创建。
- 2026-09-29：同步远端 master 至 `982f59499`，确认 OPT-001、OPT-003、OPT-006 的 MR 已分别经 `96ab3c2b5`、`982f59499`、`bd2151312` 合入 master。未收到用户承诺反馈的 001/003 CR 结论，也未核实发布与验收，因此三项保留「待验收」。OPT-007 合入最新 master，队列文件 add/add 冲突经内容比对后采用本分支的增量记录。
- 2026-09-29：OPT-007 分支 `c3fef00d3` 经 HTTPS 推送；合入 master 后聚焦测试 16/16、check、双站构建与提交前 CR 均通过。国内、国际预览先 404 后 200，各自 JS 资源集与 master 预览有分支专属脚本。无登录态浏览器不能操作推荐区；登录态视觉待验收。MR 草稿和预览详情见该项 Task Pack，移至「待确认」待用户授权创建 MR。
- 2026-09-29：补推 OPT-004 挂起文档提交 `d25332100` 至原独立分支成功，TAPD 更正评论 `1070234090217581284` 已记录；状态仍为挂起。
- 2026-09-30：用户反馈点击“测试运行”后临时自动任务残留并继续消耗 Token。建立 OPT-008 卡片 `1070234090138709055`，先入「待优化」后按 FIFO 移至「进行中」，评论 `1070234090217633716`、`1070234090217633719` 记录入队与开始。独立分支从 master `9cb7ff6a5` 创建。调查发现旧版 `2m` 被 Hermes 解析成每两分钟周期任务，最新 master 的 `f15e8db2d` 已改 `in 2m`，但既有周期测试任务仍隐藏在普通列表之外，浏览器关闭或删除失败时会继续执行；本项 Task Pack 记录清理方案及验证边界。
- 2026-09-30：OPT-008 调研完成，推荐受控盘点并暂停/删除旧周期测试任务，再做服务端持久清理和失败可观测性；无受影响实例 ID 和扣量流水，未触碰生产任务。调查文档经 `git diff --check`、文档检查；Context catalog 检查被仓库既有大量 schema/secret-scan 问题阻断。TAPD 卡片已转「待确认」，流转评论 `1070234090217633804` 记录根因与恢复条件；尚无代码实现、预览、CR 或 MR 草稿。

- 2026-10-03：核对本分支旧队列仅含 OPT-001–006；从 `/data/automation-test-task-cleanup-20260930` 干净本地提交 `c19ba0786` 保留完整 OPT-001–008 历史，并以实时 TAPD 回读校准：OPT-007 已创建 MR !4850、当前「待验收」，OPT-008 当前「待确认」治理范围。c19 来源分支当前无本地远端 ref，未仅凭本地提交宣称已推送。
- 2026-10-03：用户希望 Chat 页面加载提示更活泼可爱并增加图案/动效。建立 OPT-009 卡片 `1070234090138744537`，先入「待优化」后按 FIFO 移至「进行中」；入队与开始评论尾号 `3797`、`3798`。独立分支 `frontsandbox/chat-friendly-loading-20261003` 基于 master `0c07c1202`。计划复用现有橘橙 blob 头像与 alive 动效，统一 token、SDK chunk 与嵌入式工作台正常首屏等待；保留异常与重连。当前在做本地实现与验证；此次 Git commit/push/MR 仍须用户明确确认，历史队列授权记录不作为此次授权。

- 2026-10-03：OPT-009 本地共享组件、宿主接入与 7 语言字典已完成，聚焦 7 files / 115 tests exit 0，完整 check exit 0（TypeScript 166/171，0 new/5 resolved），国内构建 exit 0，本地 CR 无阻断。隔离真实组件浏览器预览显示 7 语言实际文本、320px 无溢出、呼吸动画与 reduced motion 生效、无 JS errors；截图和日志见 Task Pack。国际站首次完整日志对应 exit 143，随后最终重跑结果见下一条记录；全量测试 OOM、超时且多项未改范围失败后停止 exit 143，无完整汇总，不能判定 baseline。源码未提交、无线上分支预览或 MR；本地转 pending_user，待确认提交与推送，生产未发布。
- 2026-10-03：OPT-009 国际构建最终单独重跑 exit 0（session `58649`；日志 `/tmp/chat-friendly-loading-build-global-final-20261003.log`），42 条公开静态路由 SEO 与全部 postprocess 检查通过，双站构建均 exit 0。TAPD 已移至「待确认」，流转评论 `1070234090217814055`；最终双站构建成功证据已追加至评论 `1070234090217814062`，卡片描述同步并回读待确认分组 `3875`。仍待用户明确确认 Git 提交与推送预览，全量测试限制与未登录完整链路限制保留。
- 2026-10-03：用户明确回复「确认提交并推送预览」，OPT-009 恢复 `active`；TAPD 评论 `1070234090217814534` 记录范围。复用已有工蜂 SSH 认证，正在提交并推送分支，不创建 MR 或变更生产。
- 2026-10-03：用户明确确认后提交并推送 OPT-009 功能提交 `2bfd749a5`。双站 `/agents/chat` 已 HTTP 200，发布资源含新加载文案/译文且与 master 不同；匿名桌面和移动端回执正常。验证报告与 MR 草稿就绪，恢复 `pending_user` 等待创建 MR，不再次请求提交推送确认。

- 2026-10-03：用户授权「提交mr」，创建 MR !4947，opened/can_be_merged；本地 merge-tree 验证与最新 master 无冲突。TAPD流转待验收，保留全量测试与登录态验收限制。
