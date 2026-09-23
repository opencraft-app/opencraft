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
基于最新 master 修复 /subscribe/ 在手机上的双列挤压，并按 frontend/DESIGN.md 复用组件规范。

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
- pnpm check / test / build；浏览器截图及溢出测量。

## affected_paths
- frontend/next-site/subscribe-page.tsx
- 本 Task Pack。

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
- 手机单列；md 双列；lg 最多三列。使用明确的 Tailwind 断点，不通过 inline style 文本匹配。
- 复用 Card 并显式采用 DESIGN.md 的圆角值（共享 Card 的默认值尚未与规范完全一致）。
- 保留业务数据和操作回调，集中调整布局。

## scan_scope
frontend/next-site/subscribe-page*，相关测试、组件和上述 context。

## scan_output
无独立扫描产物。

## handoff
本地适配已完成；用户追加要求“合并master，提交mr”，已授权提交、推送和创建指向 master 的 MR。原工作区未改动，未发布。
分支 codex/subscribe-mobile，工作区 /Users/junweicao/.codex/worktrees/subscribe-mobile/mono2。
国内本地预览 http://127.0.0.1:5187/subscribe/。
截图、矩阵和命令日志：.local/subscribe-mobile/（忽略的本地证据，不纳入提交）。

## checkpoint
### stage
实现与双站构建完成；已执行 git fetch origin master 及 git merge origin/master（Already up to date，870d03dcb），准备提交 MR。
### verified
- 订阅页行为 55/55、类型基线及双站生产构建通过。
- 国内 7 视口与国际 28 组合无溢出，截图已人工复核。
- 相邻价格测试失败在未修改基线复现。
- 本次 Task Pack schema / link / secret 检查通过，改动 impact / diff 检查通过。
### unverified
- 全量测试及整仓 context 门禁未全绿，详见 validation。未验证线上发布或真实支付。
### discard
- 早期编辑中重复 className 和 Task Pack 缺失 metadata 已修复。
- 首次国际中文测试使用错误路径 /zh、/zh-cn，已按注册表改为 /zh-sg 并通过。
### restore
- 基线 870d03dcb；改动仅 frontend/next-site/subscribe-page.tsx 和本 Task Pack。
- 证据 .local/subscribe-mobile/；本地预览端口 5187。
### next_action
提交两个任务文件、推送 codex/subscribe-mobile，创建目标 master 的 MR；MR 描述披露验证结果和未全绿门禁。
