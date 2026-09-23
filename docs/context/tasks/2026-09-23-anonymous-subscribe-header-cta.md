---
id: anonymous-subscribe-header-cta-2026-09-23
type: task
scope: 去除订阅页未登录头部立即创建入口，消除同页导航与动作语义歧义。
status: ready-for-review
owner: wisp/mono2-maintainers
---

## goal

让未登录订阅页头部只保留“登录”主按钮，避免“立即创建”执行同页 `/subscribe` 导航并与套餐 CTA 产生语义歧义。

## non_goals

- 不修改其他公开页未登录 CTA 跳转 `/subscribe` 的既定行为。
- 不修改套餐卡订阅、支付、订阅态或已登录用户分流。
- 不合并 MR、发布或修改生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户现场反馈（2026-09-23）：未登录情况下，在订阅页点击顶部“立即创建”没有反应。
- 截图证据：国内站 `/subscribe` 桌面页，头部同时展示“立即创建”和“登录”。

## interface_refs / data_structure_refs

- `frontend/next-site/public-header-auth-island.tsx`：公开页头部认证状态与 CTA 分流。
- `frontend/next-site/subscribe-page-client.tsx`：订阅页为头部注入认证控件。
- 不变量：其他公开页未登录 CTA 继续进入 `/subscribe`；已登录用户继续按订阅状态进入 `/subscribe` 或 `/agents`。

## history_context

- `current_design_refs`：`frontend/openspec/specs/marketing.md`、`docs/context/tasks/2026-09-04-fix-cn-home-cta.md`。
- `relevant_evolution`：MR !3990 将未登录头部 CTA 统一改为 `/subscribe`；在订阅页形成同路径导航。
- `superseded_refs`：无。

## acceptance

- 未登录订阅页头部不再展示“立即创建”，只展示黑色“登录”主按钮。
- 其他公开页未登录 CTA 仍跳转订阅页。
- 已登录头部 CTA 分流不变。
- 聚焦测试、`pnpm check`、相关构建和 `git diff --check` 通过。

## affected_paths

- `frontend/next-site/subscribe-page-client.tsx`
- `frontend/next-site/__tests__/subscribe-page-client.test.tsx`
- `docs/context/tasks/2026-09-23-anonymous-subscribe-header-cta.md`

## required_context

- `frontend/AGENTS.md`
- `frontend/DESIGN.md`
- `frontend/openspec/specs/marketing.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@d45795b6a` | 前端硬规则与验证命令 | 约束实现与门禁 |
| `frontend/DESIGN.md@d45795b6a` | 现有弹窗和交互规范 | 复用登录弹窗，不新增视觉模式 |
| `frontend/openspec/specs/marketing.md@d45795b6a` | 订阅页和登录门禁现状 | 保持套餐 CTA 与公开页行为边界 |
| `docs/context/tasks/2026-09-04-fix-cn-home-cta.md@d45795b6a` | 国内未登录 CTA 历史不变量 | 其他页面继续指向 `/subscribe` |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@d45795b6a` | 前端实现与测试邻接 | 要求检查相邻组件测试 |

## evidence

- `origin/master@d45795b6a`：`goToCreate()` 对匿名用户解析为 `/subscribe`；订阅页本身为 `/subscribe`，形成同页导航。
- GREEN：相关 3 个测试文件 52/52 通过，覆盖认证岛行为、订阅页装配与套餐页回归。
- 本地国内站 `http://127.0.0.1:5176/subscribe/` 匿名桌面实测：页面中“立即创建”按钮数量为 0，头部只保留黑色“登录”主按钮且无 Next 错误遮罩。
- 点击头部“登录”后 URL 保持 `/subscribe/`，出现 `aria-label=登录` 对话框。
- 首页“免费试用”仍进入 `/subscribe/`；套餐卡“立即订阅”仍打开登录弹窗。
- 本地 HTML 验证报告与截图已生成，未纳入仓库。

## risks

- 风险：全局改变未登录 CTA 会破坏首页转化路径。缓解：仅在订阅页复用现有 `loginOnly` 模式，其他公开页默认行为不变。
- 回滚：回退订阅页的 `loginOnly` 传参。

## validation

- [x] 目标组件与订阅页回归测试：3 files / 52 tests passed。
- [x] `pnpm check`：171 current / 171 baseline / 0 new diagnostics。
- [x] `pnpm build:cn`：106 个静态页面生成，SEO 与静态资源检查通过。
- [x] 本地桌面匿名交互验证与截图。
- [x] `git diff --check`。
- [x] `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`。
- [x] `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：0 errors / 0 warnings。
- [ ] `pnpm test`：全量 312 个测试文件中 289 passed / 21 failed / 1 skipped；失败集中在未改动的模型配置、Agent 设置、文档/静态契约等测试，包含缺少 Python `cryptography`、CSS ESM 加载错误，最终 Vitest worker 触发约 4GB heap OOM。本次相关 3 个文件已独立 52/52 通过。

## decisions

- 复用认证岛现有 `loginOnly` 模式，不新增订阅页专用状态或点击分支。
- 套餐转化继续由卡片内“立即订阅”承担，未登录时打开现有登录弹窗。

## scan_scope

- `frontend/next-site/subscribe-page-client.tsx`
- `frontend/next-site/__tests__/subscribe-page-client.test.tsx`

## scan_output

- 精确搜索确认订阅页认证控件由 `SubscribePageClient` 注入，套餐 CTA 已有独立未登录登录弹窗。

## handoff

- 当前状态：实现与本地验证完成；用户已授权通过 Gongfeng MR 交付。
- 下一步：代码审阅与 CI；不在本任务内合并或发布。
- 阻塞项：仓库全量 Vitest 当前不全绿，详见 validation；不影响本次聚焦用例与国内构建结论。
