---
id: task-subscribe-mobile-2026-09-23
type: task
scope: Subscribe 页面移动端响应式布局。
triggers: ["subscribe mobile", "订阅移动端", "套餐响应式"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - frontend/next-site/subscribe-page.tsx
  - frontend/DESIGN.md
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

# Subscribe 移动端适配

## goal
基于最新 master 修复 /subscribe/ 在手机上的双列挤压，并按 frontend/DESIGN.md 复用组件规范；按用户追加要求，在所有登录和销售状态下屏蔽剩余名额提示。

## non_goals
- 不改价格、促销、套餐数据、登录、支付或升级逻辑。
- 不发布，不改原工作区现有任务；本次用户追加授权提交、推送及创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
用户本次请求及手机截图：“拉取最新的分支，/subscribe/页面，参考最新的组件规范，做一下移动端的响应式适配设计。”
截图为国内站；布局属于双站共用组件，国内为主验收，补国际站长文案回归。

## interface_refs / data_structure_refs
- frontend/next-site/subscribe-page.tsx：PlanInfo / PlanCard / planTiers。
- 保持 variants、aiDurationKey、onSubscribe 及所有禁用条件不变。

## history_context
- current_design_refs：frontend/DESIGN.md，frontend/AGENTS.md。
- relevant_evolution：2026-07-28-frontsandbox-global-pricing-page.md 说明套餐按 tier 分组；当前响应式样式仅匹配 repeat(3)，两档套餐未覆盖。
- baseline：origin/master 870d03dcb；独立 worktree，分支 codex/subscribe-mobile。
- superseded_refs：无。

## acceptance
- 320 / 375 / 390 / 430px 手机单列，卡片、价格、额度和权益无横向溢出或裁切。
- 768px 起恢复多列；桌面保留完整套餐对比。
- 月付/季付、额度切换及订阅入口可用。
- 国内／国际均不展示剩余名额，售罄状态和购买资格判断保持不变。
- pnpm check / test / build；浏览器截图及溢出测量。

## affected_paths
- frontend/next-site/subscribe-page.tsx
- frontend/src/components/ui/card.tsx 及聚焦测试
- frontend/DESIGN.md
- 本 Task Pack 与 evidence/2026-09-23-subscribe-mobile/。

## required_context
frontend-product-surface、service-frontend、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| frontend/AGENTS.md@870d03dcb | 最近服务入口 | 组件复用及验证门禁 |
| docs/context/project/services/frontend.md@870d03dcb | must_read | 前端边界 |
| docs/context/domains/site-environment-routing.md@870d03dcb | must_read | 双站共用布局 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@870d03dcb | 必查邻居 | 检查订阅页 CN/global 相邻测试及 vitest.config.ts |
| frontend/DESIGN.md@870d03dcb | 最新组件规范 | rounded-md、复用 Card、按钮移动端全宽 |
| frontend/openspec/spec.md@870d03dcb | 当前规格入口 | 现有升级语义不变 |
| frontend/openspec/changes/2026-07-28-frontsandbox-global-pricing-page.md@870d03dcb | 相关历史 | 保持 tier 分组 |
| docs/context/tasks/TASK-TEMPLATE.md@870d03dcb | 任务契约 | 本记录结构 |
| docs/context/tasks/CHECKPOINT-TEMPLATE.md@870d03dcb | 检查点契约 | 交接记录 |
| .agents/context/change-impact.json@870d03dcb | 设计文档映射 | next-site UI 未命中强制设计同步路径 |
| .agents/skills/baseline-ui/SKILL.md | UI 实现 | Tailwind / cn / 触控尺寸 |
| .agents/skills/fixing-accessibility/SKILL.md | 控件回归 | 可访问名称与焦点 |
| .agents/skills/product-skills/lv-vibe-coding/SKILL.md | 研发协作 | 最新 master、独立分支、本地验证；用户已授权本地适配 |

| docs/context/flows/tapd-gongfeng-delivery.md@ac1735ca0 | 评审修正交付路由 | 更新已有 MR 的授权与证据边界 |

## evidence
- git fetch origin master：7595dcaeb → 870d03dcb。
- 初始路由 query `/subscribe/ 页面移动端响应式适配，参考最新组件规范` 未匹配，按 frontend 页面路径重新路由成功。
- 精确路径查找 `frontend/src/pages/marketing/agent-subscribe-page.tsx` 与 `frontend/src/next-site/subscribe-page-client.tsx` 未命中，限定 frontend 文件名搜索定位到 next-site/subscribe-page.tsx。
- 根因：页面末尾 style 属性字符串选择器仅命中三列，当前两列未触发移动端折叠。

## risks
共享页面需验证国际站长文案；回滚仅恢复订阅页样式。

## validation
- pnpm install --frozen-lockfile：通过，未修改 lockfile。
- pnpm check：通过；171 个既有 TypeScript 诊断，0 新增，i18n / 文档同步检查通过。
- pnpm exec vitest run next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx next-site/__tests__/plan-pricing-consistency.test.ts --maxWorkers=1 --testTimeout=15000：79 passed / 1 failed；订阅页 55/55 全通过。失败是价格文档期望首购 40.8，实际 0；临时使用 git show HEAD 原始订阅源码重跑同一价格测试，仍为 24 passed / 1 failed，已还原本次改动。
- pnpm test：已运行；多个工作台、模型配置、文档等失败，最终一个 worker 持续占用 CPU，运行 6 分钟后停止，未获得完整总数。早期聚焦并行超时改为串行后消失。
- pnpm build:cn / pnpm build:global：均通过，分别 106 / 664 静态路由；构建生成字体已恢复，未纳入改动。
- Playwright 国内 7 宽度（320/375/390/430/768/1024/1440）均无溢出；国际 7 语言 × 4 宽度（320/390/768/1440）均无溢出。中文国际路径为 /zh-sg/subscribe/。
- 月付/季付切换、额度切换及订阅打开微信登录弹窗通过；未提交订单。
- validate_documentation：errors=[]，无坏链。
- validate_context --build-catalog：未通过，存在历史 Task Pack metadata/字段缺失及服务 context 预算问题；本 Task Pack 的初始 metadata 问题已补齐，单文件 schema / link / secret 检查 errors=[]。
- context unittest：22 passed / 4 failed（整仓治理检查，执行时包含本次尚未补齐的 metadata）；context-audit unittest：33/33 passed；audit_context：执行成功，未做人工评测，不给数值评级。
- validate_change_impact --staged：通过，未暂存；另用 --changed-file 明确传入本次两个文件通过，无命中架构映射。
- git diff --check：通过。

## decisions
- 当前两档套餐手机单列、md 双列；兼容三档时 md 三列，保留原有平板 16px 间距。没有新增在售档位。
- Card 新增 pricing / pricing-featured 显式变体，保留 12px / 16px 与无阴影；默认外观不变，页面不覆盖圆角或阴影。
- 保留业务数据和操作回调，集中调整手机布局。恢复 motion.create(Card) 的 fadeIn / stagger 和 hover，保留 overflow-hidden；用户最新要求屏蔽剩余名额，已删除显示区域和专用映射字段，保留售罄判断。

## scan_scope
frontend/next-site/subscribe-page*，相关测试、组件和上述 context。

## scan_output
无独立扫描产物。

## handoff
本地适配已完成；用户追加要求“合并master，提交mr”，已授权提交、推送和创建指向 master 的 MR。原工作区未改动，未发布。
分支 codex/subscribe-mobile，工作区 /Users/junweicao/.codex/worktrees/subscribe-mobile/mono2。
国内本地预览 http://127.0.0.1:5187/subscribe/。
截图与矩阵：[评审证据](evidence/2026-09-23-subscribe-mobile/README.md)，已纳入版本控制；本地日志仍在 .local/subscribe-mobile/。

## review_followup
用户评审要求恢复桌面圆角／名额间距／动效，提供 MR 可见证据，兼容三档平板布局，并确认现网当前仅两档。实施以上限定修正；三档只用本地 fixture 验证，不增加线上套餐。
主题 --radius-md 实际为 1rem（16px），此前不是 6px；普通卡 12→16px 的变化仍然恢复。

历史评审证据：屏蔽名额之前，国内桌面 1024 / 1440px before/after 像素差为 0；原圆角、名额位置、hover 一致。此后用户明确要求所有状态屏蔽名额，最新 quota-hidden 截图取代含名额截图。国内 7 视口、国际 28 组合无溢出；三档仅本地 fixture，在 768 / 1023px 同行三列，无裁切。

## hide_quota_followup
用户明确要求“这个不可展示，先屏蔽掉吧”。国内／国际、登录／未登录、手机／桌面统一移除名额提示。售罄标记、CTA 禁用、订单判断和后端库存 contract 保持不变。删除 PlanInfo.availableCount / totalCount 两个仅用于展示的字段与映射。
原移动端 MR !4509 已于 2026-09-23 06:23 UTC 合并，source_commit 为 086d3d252；本次名额屏蔽提交 c3e05b384 不在该合并中，改用独立后续 MR 交付。最新 master 的并行改动仅涉及镜像构建和 macOS 打包，订阅组件及 pnpm 检查输入未变。
新增 CN / global 各两条登录态组件回归：AVAILABLE 5/100 仍可订阅且不显示名额；SOLD_OUT 0/100 保持禁用且不显示名额。临时 5/100 fixture 的浏览器截图覆盖 390 / 1024 / 1440px，quota=[]，无溢出；测试数据已恢复。

## checkpoint
### stage
名额屏蔽已实施；62 项聚焦测试、check、双站构建通过。!4509 在本次推送前已合并，合并版本不含名额屏蔽；已合入最新 master 32f055720，后续由 codex/subscribe-hide-quota 单独提交 MR。国内预览已恢复，/subscribe/ HTTP 200。
### verified
- 最新聚焦行为测试 62/62（订阅页 59 + Card 3）通过；pnpm check（0 新增诊断）及 build:cn / build:global 已重新通过。
- 国内 7 视口与国际 28 组合无溢出，截图已人工复核；最新名额隐藏 fixture 的 390 / 1024 / 1440px 截图无名额提示和横向溢出。
- 相邻价格测试失败在未修改基线复现。
- 本次 Task Pack schema / link / secret 检查通过，改动 impact / diff 检查通过。
### unverified
- 全量测试及整仓 context 门禁未全绿，详见 validation。未验证线上发布或真实支付。
### discard
- 早期编辑中重复 className 和 Task Pack 缺失 metadata 已修复。
- 首次国际中文测试使用错误路径 /zh、/zh-cn，已按注册表改为 /zh-sg 并通过。
### restore
- 基线订阅源码 870d03dcb，合并 master ac1735ca0；修改范围见 affected_paths。
- 证据 .local/subscribe-mobile/；本地预览端口 5187。
### next_action
推送 codex/subscribe-hide-quota，创建仅包含名额屏蔽及测试／证据的后续 MR，保留未全绿门禁说明。
