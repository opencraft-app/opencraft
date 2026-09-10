---
id: task-console-logout-home-redirect-2026-09-10
type: task
scope: 控制台共享头像菜单退出登录后返回首页未登录态。
status: active
owner: wisp/mono2-maintainers
authority: primary
reviewed_at: 2026-09-10
review_due: 2026-12-09
revision: 1.0.0
precedence: task
derived: false
---

## goal

用户从控制台共享头像菜单退出登录时，立即以 replace 导航返回首页，由会话退出结果呈现首页未登录态。

## non_goals

- 不修改退出登录 API、Session 状态机或登录页。
- 不调整账号管理页已有的退出流程。
- 不改变未授权路由守卫行为。

## requirement_ids / requirement_refs / requirement_excerpt

- 当前用户请求：控制台头像菜单退出登录后不应停留在 `/agents` 展示“请先登录”，应直接返回首页未登录态。
- 关联 MR：`wisp/mono2!3820`。

## interface_refs / data_structure_refs

- `frontend/src/contexts/session-context.tsx`：`signOut(): Promise<void>` 保持不变。
- `frontend/src/lib/app-navigation.tsx`：使用 `navigate("/", { replace: true })`，同时兼容 Router Provider 和浏览器回退。

## history_context

- `current_design_refs`：`frontend/openspec/specs/auth.md`。
- `relevant_evolution`：账号管理页已有相同的首页 replace 导航；共享头像菜单此前仅调用 `signOut()` 并关闭菜单。
- `superseded_refs`：无。

## acceptance

- 点击共享头像菜单“退出登录”时调用 `signOut()`。
- 同一次交互调用 `navigate("/", { replace: true })`，不在浏览器历史中保留受保护控制台页。
- 组件在没有 React Router Context 时仍可渲染。
- 聚焦组件测试、前端检查和变更影响检查通过。

## affected_paths

- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `docs/context/tasks/2026-09-10-console-logout-home-redirect.md`

## required_context

- 路由查询 `frontend control console avatar menu logout navigate home unauthenticated` 未匹配现有 Domain Pack。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端服务边界与验证要求 | 约束最小实现和组件测试 |
| `docs/context/tasks/TASK-TEMPLATE.md@2.1.0` | Task Pack 格式真源 | 记录本任务状态 |
| `frontend/openspec/specs/auth.md` | 认证模块当前设计 | 保持 Session 和路由守卫边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接卡 | 核对 OpenSpec 与相邻测试 |
| `frontend/src/components/site/user-avatar-menu.tsx` | 缺陷实现入口 | 增加首页 replace 导航 |
| `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx` | 相邻组件测试 | 新增退出导航回归 |

## evidence

- 实现前精确搜索确认：账号管理页已有 `navigate("/", { replace: true })`；共享头像菜单此前仅调用 `signOut()`。
- 聚焦组件测试通过：`user-avatar-menu.test.tsx` 11/11。
- `pnpm check` 通过：i18n 结构错误 0，TypeScript diagnostics 为 175 current / 276 baseline / 0 new。
- 仓库未定义 `pnpm lint` 脚本。
- 全量 `pnpm test` 尝试出现与本改动无关的既有失败（模型配置、定价、国际首页文案等），随后持续无输出，已终止；本次新增聚焦回归保持通过。

## risks

- 风险：退出后浏览器后退重新进入受保护页。缓解：使用 replace 导航。
- 风险：共享组件不在 Router 下渲染时报错。缓解：复用带浏览器 fallback 的 `useAppNavigate()`，保留现有无 Router 测试。

## validation

- `pnpm exec vitest run --config vitest.config.ts --maxWorkers=1 src/components/site/__tests__/user-avatar-menu.test.tsx`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions

- 复用跨运行时 `useAppNavigate()`，不直接依赖 React Router，也不手写 `window.location`。
- 与账号管理页保持一致，在调用退出接口前先 replace 到首页，避免展示中间的受保护页未登录占位。

## scan_scope

- `frontend/src/components/site/`
- `frontend/src/pages/marketing/account-page.tsx`
- `frontend/openspec/`

## scan_output

- 有界搜索结果已记录于本 Task Pack；没有独立扫描产物。

## handoff

- 当前状态：实现、聚焦测试、前端检查、change-impact 和文档检查均已完成；提交 `4ba13fad9` 已推送到 MR !3820。
- 下一步：等待 MR 检查与评审；尚未合并或发布。
