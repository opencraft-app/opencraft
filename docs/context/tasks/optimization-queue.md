# 优化需求队列

更新时间：2026-09-29。此文件是队列状态的记录；每个优化点在独立分支实现。同一时刻最多一个 `active`；`pending_user` 可暂存多个，统一从 TAPD 看板「待确认」分组回溯。

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
- [OPT-001 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685577)：`1070234090138685577`，当前「待确认」。
- [OPT-002 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685578)：`1070234090138685578`，当前「待确认」。
- [OPT-003 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685610)：`1070234090138685610`，当前「待确认」。
- [OPT-004 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685615)：`1070234090138685615`，当前「待确认」，等待数据范围决定。
- [OPT-005 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685654)：`1070234090138685654`，用户指定插队，当前「待确认」。
- [OPT-006 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138690655)：`1070234090138690655`，当前「进行中」。

## 需求清单

| ID | 需求 | 状态 | 独立分支 | 验收目标 | 下一步 |
|---|---|---|---|---|---|
| OPT-001 | Review `/subscribe` 页“首月 6 折”等优惠标签展示逻辑 | `pending_user` | `frontsandbox/subscribe-promotion-badge-20260929` | 有真实适用优惠时显示“免费”或实际折扣；无适用优惠时不显示促销标签 | 双站预览、提交前 CR、MR 草稿就绪；等待用户确认创建 MR |
| OPT-002 | 微信快捷登录在弹窗内完成授权，展示快捷登录按钮或待扫描二维码 | `pending_user` | `frontsandbox/wechat-login-in-modal-20260929` | 弹窗内嵌微信授权；确认后允许当前页回跳 | 已提交推送，双站预览 200、CR 与 MR 草稿就绪；真实微信客户端验收需同站部署 Auth 后端；待确认创建 MR |
| OPT-003 | `/subscribe` 套餐卡强调外框随 Hover 移动 | `pending_user` | `frontsandbox/subscribe-card-hover-border` | 鼠标移入任一卡片时强调该卡；移出全部卡片后不固定强调某张卡 | 已提交推送、CR 与 MR 草稿就绪；双站预览 200，待确认创建 MR |
| OPT-004 | `/account/billing/` 展示已有订单列表 | `pending_user` | `frontsandbox/account-billing-order-list` | 将当前账号真实订单或真实空态作为独立区块置于「订阅套餐」大卡片下方 | 现有隐藏页是演示数据，真实历史 API 缺失；调查记录已推送，等待用户决定真实接口或先做真实空态；尚无实现/预览/MR |
| OPT-005 | `/subscribe/` 套餐售罄交互与「需求加急」 | `pending_user`（用户指定插队） | `frontsandbox/subscribe-soldout-urgent` | 国内外付费卡保留灰显价格和功能点，售罄 CTA 改为加急反馈；国际站联系入口为 Discord；售罄绝不进入下单 | 已提交推送、CR 与 MR 草稿就绪；双站预览 200，待确认创建 MR |
| OPT-006 | 国内、国际站移动端首页左下角出现字面量 `\n` | `active` | `frontsandbox/mobile-stray-escape-20260929` | 双站首页页脚下方不再显示转义符；重新导入静态首页素材不会复发 | 修复提交 `dacd70543` 已推送；聚焦测试、check、双站构建、CR、MR 草稿就绪；预览域名当前 404，待发布验收 |

## 当前处理项

| ID | 需求 | 状态 | 独立分支 | 下一步 |
|---|---|---|---|---|
| OPT-006 | 双站移动端首页左下角转义符 | `active` | `frontsandbox/mobile-stray-escape-20260929` | 等待双站预览发布并验收后移至待确认；OPT-004 继续暂存，用户回复后排为下一项 |

## 待确认（看板统一回溯）

| ID | 卡片 | 需用户决定 | 恢复条件 |
|---|---|---|---|
| OPT-001 | [订阅页促销标签](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685577) | 是否创建已准备好的 `frontsandbox/subscribe-promotion-badge-20260929` → `master` MR | 用户确认后创建 MR，进入「待验收」；完整提交信息见卡片评论 |
| OPT-002 | [微信登录弹窗](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685578) | 是否创建 `frontsandbox/wechat-login-in-modal-20260929` → `master` MR | 双站预览已返回 200；用户确认后创建 MR；真实扫码验收需同站 Auth 部署与微信客户端 |
| OPT-003 | [套餐卡 Hover 外框](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685610) | 是否创建 `frontsandbox/subscribe-card-hover-border` → `master` MR | 双站预览已返回 200；用户确认后创建 MR |
| OPT-004 | [账单页订单列表](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685615) | 本次接真实订单查询接口，还是先做列表结构与真实空态？ | 用户选定范围后恢复实现、测试、预览、CR 和 MR 准备；不能展示演示订单 |
| OPT-005 | [售罄加急交互](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138685654) | 是否创建 `frontsandbox/subscribe-soldout-urgent` → `master` MR | 双站预览已返回 200；用户确认后创建 MR；完整信息见卡片评论 |

## 等待队列（FIFO）

| 顺位 | ID | 需求 | 状态 | 独立分支 | 进入条件 |
|---|---|---|---|---|---|
| — | — | 当前无尚未启动的新需求；OPT-004 暂存待确认 | — | — | 用户明确订单数据范围后恢复 |

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
