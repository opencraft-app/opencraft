---
id: task-bot-setup-refresh-2026-09-21
type: task
scope: Bot 创建引导在同标签页刷新后的恢复与定时任务去重。
triggers: ["Bot 创建刷新恢复", "创建进度快照", "定时任务去重"]
owner: jasminzhao
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-onboarding-panel.tsx
  - frontend/openspec/specs/agent-onboarding-recovery.md
status: active
reviewed_at: 2026-09-21
review_due: 2026-12-20
revision: 1.0.0
precedence: task
derived: false
---

# Bot 创建刷新恢复

## goal
在当前分支的 Bot 创建引导中提供离页提示和刷新后继续配置，避免半成品被当成完成或重复创建任务。

## non_goals
- 不修改国际站发布开关，不新增后端任务系统，不合并 MR 或发布；用户已明确授权提交和推送 MR。
- 本轮不提供跨设备、关闭标签页后的恢复；创建 API 响应尚未返回时不自动重发创建请求。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-21：接续 CodeBuddy 创建中刷新兜底任务。
- wiki/prd-docs/2026-09-20-agent-onboarding-and-overview.md：配置进度和部分失败展示。

## interface_refs / data_structure_refs
- agent-buddy-setup.ts SetupStep / buildBuddySetupPlan；agent-buddy-setup-runner.ts runBuddySetupPlan。
- 快照只能恢复到当前页面已确认的 Bot / profile，不从本地快照任意选择执行目标。

## history_context
- current_design_refs：上述 PRD、frontend/openspec/specs/buddy.md。
- relevant_evolution：dc30748aa 国内站先上线；ea434891a 修复重挂载、语言及 profile 定向。
- 接手时已有 4 个修改文件及 2 个新文件（progress 模块及测试），在其基础上修复。
- superseded_refs：无。

## acceptance
- 创建期间触发 beforeunload，完成或失败停止拦截。
- 等待沙箱、首步进行中、已写基础配置时刷新都能恢复；不同 Bot 不串写。
- 定时任务重试/恢复在沙箱内串行检查，无法确认已有任务时明确失败，不盲建。
- 聚焦行为测试、pnpm check/test/build 和 context 门禁有命令证据。

## affected_paths
- frontend/src/pages/marketing/agent-buddy-setup*、agent-onboarding-panel.tsx、agent-settings-page.tsx 及相邻测试。

## required_context
- 路由集合：frontend-product-surface / service-frontend / site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md（用户提供） | 仓库边界 | 提交需授权；Task Pack 与门禁 |
| frontend/AGENTS.md | 最近服务入口 | check/test/build |
| docs/context/project/services/frontend.md@2.1.0 | 路由 must_read | 前端规格权威 |
| docs/context/domains/site-environment-routing.md@2.0.0 | 路由 must_read | 保持站点门禁 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0 | 邻接卡 | 核查 vitest.config.ts、相邻组件测试 |
| docs/context/tasks/TASK-TEMPLATE.md@2.1.0 | 任务状态 | 本文件 |
| docs/context/tasks/CHECKPOINT-TEMPLATE.md@2.0.0 | 交接 | checkpoint |
| .agents/context/change-impact.json | 影响映射 | 本轮 marketing 路径不命中正式设计强制更新 |
| frontend/openspec/plan.md | 当前计划 | 追加本轮未完成项 |
| frontend/openspec/specs/buddy.md | 当前人设边界 | 避免覆盖克隆人设 |
| wiki/prd-docs/2026-09-20-agent-onboarding-and-overview.md | 分支需求 | 创建顺序与补救方式 |

## evidence
- git branch --show-current：jasminzhao-newuser-92；HEAD dc30748aa。
- 首次路由 query「创建 Bot 过程中刷新页面 中断 创建流程 兜底 当前分支」无匹配；对 frontend/src/pages/marketing/agent-buddy-setup* 精确检索成功后按路径重跑路由。

## risks
- beforeunload 受浏览器限制，sessionStorage 不可用时不能保证恢复。
- 创建 API 返回前的未知结果仍需通过已有 Bot 列表确认；本轮不宣称服务端全程 exactly-once。

## validation
- `pnpm test` 定向运行 8 个文件：136 项通过（含 Bot/profile 隔离、零步骤恢复、完成步骤跳过、离页提示解除、真实 Shell/Python 并发去重）。
- `pnpm check`：退出码 0；语言结构/繁简/文档同步通过；类型诊断 172 current / 276 baseline / 0 new。
- `pnpm build:cn`：单独复跑退出码 0；静态页面和 SEO 检查通过。首次并发执行遇到文档生成导出缺失，串行复跑已消除。
- 全量 `pnpm test`：275 文件通过，26 失败，1 跳过；3535 测试通过、147 失败、14 跳过，2 个 worker 错误。该次运行的两个本轮源码文本断言已更新并通过随后聚焦回归；其余失败未在本任务扩展修复，未宣称全量通过。
- `validate_documentation.py --repo . --format json`：错误 0、损坏链接 0。
- `validate_context.py --build-catalog`：全仓历史任务 metadata/schema/secret-literal 检查仍失败；本任务修正 metadata 后单独调用现有 schema validator 返回零错误，未输出敏感值。
- Context 单测：26 项中 4 失败（依赖整仓治理扫描）；context-audit 单测 33 项通过；audit 脚本退出码 0，needs_agent_review（不宣称完成全仓评估）。
- `validate_change_impact.py --repo . --staged` 通过（无暂存）；对本轮三个主要变更路径显式检查通过，不命中设计映射。
- `git diff --check` 通过。构建和 catalog 生成的无关文件已恢复到入场版本。

## decisions
- 提示只是预防；用按 Bot 隔离的快照恢复、沙箱内定时任务检查处理刷新后的结果未知。

## scan_scope
- 扫描范围：`frontend/src/pages/marketing`、`frontend/src/lib/hermes-cron-client.ts`、`frontend/openspec`。

## scan_output
- 本地有界检索摘要见 evidence，不持久化敏感数据。

## handoff
- 用户已明确授权提交 MR，沿用现有 !4311；不执行合并或发布。
- 本地组件和命令验证通过，尚未做真实云端 Bot 的浏览器联调。全仓测试及 context 门禁未全绿，MR 描述保留全量失败及未覆盖的真实云端验收边界。
- 长期行为已记录到 `frontend/openspec/specs/agent-onboarding-recovery.md`。

## checkpoint

### stage
实现及聚焦验证完成，国内站构建通过，MR 提交与 master 冲突处理阶段。

### verified
- 8 个测试文件共 136 项通过，含并发 Shell/Python 定时任务验证。
- pnpm check：TypeScript 172 current / 276 baseline / 0 new；语言和文档同步检查通过。
- 文档完整性检查无 errors，docs-impact 通过（本轮 marketing 路径不命中映射）。

### unverified
- 全量测试与 Context 门禁未全绿，详细数量见 validation；不承诺真实云端验收已完成。
- Context 历史 Task Pack 存在 schema / 中文优先等检查失败；本任务 schema 已补齐。

### discard
- 单靠 beforeunload、按步骤数量指纹、无 Bot 隔离快照和前端先查后建的旧方案均已替代。

### restore
- 初始未提交改动已在原分支接续；修复提交 623effd69 已创建；同步 master 0ce20f94d 后更新 MR !4311。
- 日志保存在 /tmp/buddy-*.log；本轮更改不会自动发布。

### next_action
- 完成合并后验证，推送当前分支并更新现有 MR !4311；合并与发布仍不在授权范围。


## 最终确认前复查（2026-09-21）

用户要求核对国内站创建 Bot 到总览的全部分支，本轮仅审查，未修业务代码；本地运行环境仍为用户指定的国际站 5174。

### 新验证证据
- 显式 `NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm test` 定向运行创建/订阅/区域/快照/执行器相关 10 个文件：161 项通过，日志 `/tmp/buddy-cn-final-review.log`。
- 核对入口、计划执行、错误态、最终跳转与总览统计源码；组件测试通过不代表页面层所有状态转换闭环。

### 复查发现（已在后续 MR 提交阶段修复）
1. `agent-settings-page.tsx:2986`：前置引导的 profileId 只来自 provisioningBot。携带 creating 参数但 Bot 已 active，或配置期间从 provisioning 转 active 后，该值变空；引导锁又阻止切换到普通面板，可能一直等 profile 直到超时。应按已确定的目标 Bot ID 从完整列表取 profile，覆盖两种状态。
2. `agent-onboarding-panel.tsx:697`：复制 Bot 的人设读取失败/无法解析时继续按新建语义覆盖 SOUL。应保留原文件并明确报错或重试，不能把读取失败解释为没有人设。
3. `agent-onboarding-panel.tsx:802` 与 `agent-creating-loading.tsx`：阻断错误清快照并停在错误页，错误态没有继续配置/返回入口。应提供绑定同一 Bot 的重试或退出，避免重新创建 Bot。
4. `agent-hero-stats.ts:69`：定时任务统计只随 Bot/profile 改变拉取，配置结束未显式刷新；同 Bot 的 hook 没有重挂载时，总览可能显示配置前的旧数量。

### 产品确认边界
- 全成功自动进入新 Bot 总览；只有部分失败需要点击“进入 Bot”。
- 仅 SOUL 写入是计划中的必需步骤；资料/画像/技能/定时任务/网关失败都属于部分失败。
- 选模板使用模板的名称、简介、头像；复制后再选模板覆盖人设并追加模板配置，不主动清空其他复制配置。
- 表单阶段草稿未持久化；自动恢复要求拿到 Bot ID、同标签页、30 分钟内且存储可用。创建 API 返回前的未知结果、关页/跨设备、部分失败记录的持久保留均未完整覆盖。

### checkpoint 更新
当前阶段：确认前审查，不能将整条链路标记为全部验收完成。
已验证：161 项国内站相关测试通过，正常路径和现有保护已梳理。
未验证：上述四个风险的修复与页面集成回归；真实云端中途刷新。
下一步：向用户展示流程矩阵和未闭环项，按其确认继续修复与验收。

## MR 提交阶段 checkpoint（2026-09-21）
- 用户已授权提交 MR；当前分支已有 !4311，沿用该 MR。
- 已修复上述四项：完整列表解析目标 profile；克隆读取失败停止写入；同 Bot 重试并保留进度；完成配置后刷新定时任务数量。
- 新增组件回归覆盖读取异常/缺失/无效/失败状态、重试只建一个 Bot、统计刷新与迟到响应隔离。
- 初次回归揭示订阅测试原本因 profile 缺失而卡在进度页；已改为验证实际完成并到达目标 Bot 总览。
- 已同步 master 0ce20f94d；翻译使用逐键三方合并无双边不同修改，设置页保留国际站创建入口规则及国内站引导，两边维护互斥测试和无侧栏样式均保留。最终验证结果见下。

### 最终命令证据
- 合并后国内聚焦回归：15 文件 / 228 项通过；补充创建完成跳转、空状态/总览回归 4 文件 / 19 项通过，全部创建入口回归 1 文件 / 5 项通过。
- `pnpm check` 最终通过：171 current / 276 baseline / 0 new / 105 resolved；翻译错误 0、告警 50。中途 fumadocs 生成时序重试后通过。
- `pnpm build:cn` 最终通过；首次失败原因为构建清理 `.next` 与运行中的国际站预览目录冲突，停止预览后复跑成功，随后已恢复国际站 5174。
- 国内环境全量 `pnpm test --maxWorkers=4`：282 文件通过、20 失败、1 跳过；3644 项通过、117 失败、13 跳过，1 worker 错误。`plan-select-page.test.tsx` worker 持续无输出、内存增长超过 3 GB，主动终止该 worker；不宣称全量通过。
- 上述全量中的 `agent-create-bot-paths` 旧进度页断言已修正并复跑 5 项全部通过。国际环境补验：区域/引导开关与 debug exec 共 38 项通过，定时任务面板 6 项因缺少 ResizeObserver 测试环境而失败。其余全量失败分布在模型配置、文档/本地化、套餐等，本轮未扩展修复。
- 文档检查 errors 0；docs-impact 暂存检查通过；context 全仓校验仍失败，context 单测 26 项 / 4 失败，context-audit 33 项通过，audit 完成但未进行全仓人工评估。
- 浏览器仅完成本地未登录页面验证；真实云端 Bot 刷新、强关标签页/跨设备恢复不在本轮验证结论内。

### 交接状态
- 本轮四项复查问题均已修复并提供回归；既有 !4311 指向 master，待用户代码评审。
- 不执行 MR 合并或生产发布；国际站继续沿用原创建流程。

## CR 跟进 checkpoint（2026-09-21）
- 用户评审指出 Agent Console vendoring 漂移、网络错误泄漏细节、GitHub ref 契约含糊与推荐模板 ID 缺少回归。沿用本任务和 MR !4311 处理。
- 当前设计：`opencraft/MONO2_MIGRATION.md` 与正式 `agent-gateway-runtime.md` 明确 frontend 真源 → 机械生成闭包；必须先提交源码，再运行同步脚本，提交生成文件及记录真实 sourceRevision 的 UPSTREAM.json。
- 历史定位：初次 `npm run check:mono2-agent-console` 在 `i18n/generated/en-US.json` 报漂移，不能只修三份 TS 副本。评审所述“国际站构建使用旧副本”需区分：官网 frontend 直接使用真源，OpenCraft 消费生成层。
- 新增实际 context receipt：`opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md`、`docs/context/project/services/opencraft.md`、`docs/context/domains/agent-gateway-runtime.md`、`docs/context/project/upstream-subtrees.md`、`docs/engineering/domains/agent-gateway-runtime.md`、`docs/engineering/domains/site-environment-routing.md`，及已复读的 frontend / site 路由 must_read、邻接卡和最近服务入口。
- 已先 fetch 并合并最新 master f09b62866，无冲突；生成前将以合并后的源码为准。
- 计划：错误详情仅留 cause；GitHub ref 明确只接受分支（现有调用全为分支），不扩展 tag 安装；对推荐 ID 与实际合并模板目录做双语言回归。随后提交真源、机械同步完整闭包并验证。
- 当前验证：待运行本轮聚焦测试、frontend check/build、OpenCraft 同步/漂移检查与 gate；既有全量测试未全绿记录继续保留。

### CR 验证与三次门禁问题后的 checkpoint
- 真源修复提交 `7bc546bd7` 后重新执行同步；`UPSTREAM.json.sourceRevision` 指向该提交，130 个 sourceSha256 全部与真源一致，`npm run check:mono2-agent-console` 通过。更新 15 个生成文件（含清单、八份翻译资源、评审列举的三个 TS 文件及同闭包依赖）；未手改生成副本。
- 前端 4 文件 / 110 项聚焦测试通过，覆盖实际目录合并后的推荐模板 ID、HTTP 友好提示与原始 cause、技能命令与 Profile 隔离。`pnpm check` 通过：171 current / 171 baseline / 0 new；`pnpm build:global` 与 `pnpm build:cn` 均通过。
- OpenCraft `check:boundaries`、全部 workspace typecheck、Electron launch 4 项、扩展 164 + 56 项通过。首轮 AppServer 因 Node 22.12 的 SQLite 默认关闭失败，使用 `NODE_OPTIONS=--experimental-sqlite` 后继续；第二轮因 node-pty 预编译 spawn-helper 缺少执行权限失败，修复本地依赖权限后 AppServer 166 项全部通过。这些运行环境调整未进入 Git。
- 门禁分段续跑：projects 15、thread lifecycle 56、native speech 36 项通过；DSH bridge 214 项通过、3 项失败，均因本地缺少 `runtime/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`。本轮不扩展到 DSH runtime 安装与其他平台验收；完整 gate 未通过，后续链式命令未执行。
- 单独 `npm run build:web` 通过，证明 OpenCraft Web 可解析同步后的消费闭包；尚未验证真实 Electron/Expo 窗口或云端模型链路。frontend 全量测试的先前未全绿记录仍有效，本轮未重复运行无关全量测试。
- 文档完整性错误 0；源码提交 docs-impact 通过；同步提交前继续检查 docs-impact、diff-check 和漂移校验。
- 国际站 5174 已恢复并返回 HTTP 200。当前阶段：提交生成闭包、推送并更新 MR 评审说明；不合并或发布。

## Inline CR profile 隔离 checkpoint（2026-09-21）
- 目标：处理 !4311 的两条 inline 问题，资料读取和总览编辑禁止未知 profile 回落 main；不扩展部署、云端执行或无关聊天重构。
- context_receipt：复读 frontend service、site-environment-routing、frontend/AGENTS.md、frontend-runtime-openspec-i18n 邻接卡、agent-hero-stats-refresh 测试；读取 opencraft/AGENTS.md。沿用本 Pack 已记录的设计与历史。
- 先 fetch 最新 master 9733d9774，合并提交 18ab48700；手工合并设置页引导与新调试对话入口规则，翻译保留双方新增键，机械再生成 UPSTREAM 清单解决冲突。
- 修复：空 profile 不读写，缓存按 Bot/profile 隔离，编辑卡等待 profile、目标变化关闭草稿并取消后续命令。明确 main 的主 Bot 仍可读写。
- 当前验证：首轮测试暴露新测试 mock 缺少 t 导出与元数据标记，已修正；侧边栏守卫需要合并后的禁用条件，已更新。另四项侧栏测试仍断言 master 已移除的旧 SDK bridge/状态管理，待记录最终验证结果，不扩展恢复旧实现。
- 已同步长期恢复 spec 与正式运行时 Profile 隔离设计。待完成聚焦测试/check/双站构建，再提交真源、生成清单、推送 MR。

### Inline CR 最终验证
- 聚焦回归最终 9 文件 / 109 项全部通过，包含新增 13 项资料隔离测试、创建全入口、恢复、单次执行、侧栏守卫。已适配 master 的 legacy/OpenCraft 双桥命名、状态重置和 mutation pending 禁用规则；创建路径测试隔离聊天/通道 SDK 的浏览器 CSS。
- `pnpm check` 和最终 `pnpm typecheck` 通过：171 current / 171 baseline / 0 new；翻译错误 0。合并 master 后本地补装锁文件已包含的 fflate，未改依赖清单或锁文件。
- `pnpm build:cn`、`pnpm build:global` 均通过。构建期间暂停国际预览，完成后恢复同一国际代理配置与 5174 端口。
- 文档完整性 errors 0；context 校验仍因既有治理问题失败，context 单测 26 项 / 4 失败，context-audit 单测 33 项通过、audit 完成。未重复运行此前已记录未全绿的 frontend 全量 / OpenCraft 全量 gate；不宣称云端端到端验收通过。
- 下一步：源码提交后同步 UPSTREAM revision、运行漂移与 docs-impact 检查并推送 !4311；不合并或发布。
