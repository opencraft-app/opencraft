## goal
首页退出登录后，导航右上角只出现一个可用的登录按钮。

## non_goals
- 不修改会话协议、登录弹窗、退出登录落点或发布配置。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-report-2026-10-01`：用户截图显示从登录态退出并返回国内首页后，右上角并排出现两个“登录”按钮。

## interface_refs / data_structure_refs
- `PublicHeaderAuthIsland` 的 `loginOnly` 模式负责首页匿名导航。
- 登录点击仍须打开现有登录弹窗，并保留桌面与移动埋点口径。

## history_context
- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`、`frontend/next-site/international-home-runtime.tsx`。
- `relevant_evolution`：首页使用静态片段和独立 React 鉴权控件；退出入口由共享头像菜单处理。
- `superseded_refs`：无。

## acceptance
- `loginOnly` 匿名状态在 DOM 中只有一个登录按钮，登录态切到匿名态后仍只有一个。
- 桌面和移动视口均显示可点击的登录入口；登录弹窗、locale 和其他公开页 CTA 不回归。
- 聚焦测试、前端检查和差异检查通过。

## affected_paths
- `frontend/next-site/public-header-auth-island.tsx`
- `frontend/next-site/__tests__/public-header-auth-island.test.tsx`

## required_context
- `site-environment-routing`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 国内与国际站边界 | 保持双站导航行为一致 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端验证边界 | 选择聚焦测试与类型检查 |
| `frontend/AGENTS.md@working-tree-2026-10-01` | 最近服务规则 | 限定前端验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 组件与测试邻接 | 检查相邻测试及历史规格 |
| `frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md@working-tree-2026-10-01` | 首页鉴权控件历史约束 | 保留移动端和多语言入口 |

## evidence
- 线上独立未登录直达首页时，一个桌面按钮可见；React 组件同时渲染两个同名按钮，另一个依赖 CSS 隐藏。
- 聚焦 Vitest RED：新增单入口断言失败，确认现有 DOM 有两个同名按钮。
- GREEN：`public-header-auth-island` 与 `international-home-rendering` 共 56 项测试通过。
- `pnpm check` 通过：i18n 结构错误 0，TypeScript diagnostics 166 current / 171 baseline / 0 new / 5 resolved。
- 国内站本地预览：1280px 桌面与 390px 手机视口各只有一个登录按钮；手机点击打开现有登录弹窗。预览将认证目标指向不可用本地端口，仅用于确认匿名状态。
- 文档完整性检查通过；`git diff --check` 通过。

## risks
- 单入口响应式样式可能影响其他公开页；用相邻组件测试和桌面、移动预览核对。
- 未使用真实账号执行完整退出登录链路；组件测试覆盖登录态切换到匿名态，生产生效仍取决于后续合并和发布。

## validation
- `cd frontend && pnpm exec vitest run --config vitest.config.ts next-site/__tests__/public-header-auth-island.test.tsx --api.host 127.0.0.1`
- `cd frontend && pnpm check`
- `git diff --check`

## decisions
- `loginOnly` 使用同一个响应式登录按钮，避免在页面切换或样式加载期间同时暴露两个可操作按钮。
- 非 `loginOnly` 的创建与登录组合保留现有结构。

## scan_scope
- `frontend/next-site/`、`frontend/src/components/site/` 的首页鉴权入口及相邻测试。

## scan_output
- `InternationalHomeRuntime` 只挂载一次鉴权岛；静态首页片段的导航动作容器为空。重复文案来自鉴权岛自身的桌面和移动按钮。

## handoff
- 本地修复与验证完成；用户随后授权提交 MR，远端状态以工蜂 MR 为准。未发布。
