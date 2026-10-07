## goal
让公开站点首页右上角的登录用户头像图片点击后进入 `/agents`。

## non_goals
- 不改头像旁箭头、菜单“账号”入口、Agent 侧栏头像或 `/agents` 权益门禁；不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 确认：头像当前跳转账号页，并要求改为 `/agents`。

## interface_refs / data_structure_refs
- `UserAvatarMenu` 的 `header` 变体中头像链接；目标复用 `AGENTS_HOME_PATH`。
- 菜单内“账号”仍指向 `/account`，`NextAgentEntitlementGate` 继续处理直接访问 `/agents` 的资格。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: 当前头像链接为 `/account`，箭头按钮展开菜单，菜单另有独立“账号”入口。
- superseded_refs: 无。

## acceptance
- 点击 Header 头像图片进入 `/agents`；箭头仍可展开菜单；菜单“账号”仍进入 `/account`。
- 保持原生 `<a>` 导航和现有权益门禁。

## affected_paths
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `frontend/next-site/__tests__/static-navigation.test.tsx`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- frontend-product-surface。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@20ee7b3d9` | 服务边界 | 前端验证 |
| `frontend/AGENTS.md@20ee7b3d9` | 服务规则 | 测试与构建门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@20ee7b3d9` | 邻接 | 检查组件与导航测试 |

## evidence
- `UserAvatarMenu` Header 头像链接当前指向 `/account`；头像菜单“账号”独立指向 `/account`。
- `NextAgentEntitlementGate` 对 `/agents` 保持原有门禁。
- Header 头像链接已改为 `AGENTS_HOME_PATH`；菜单组件聚焦测试 4/4、静态导航测试 3/3 通过。
- 静态导航测试原有的两个整模块 mock 缺少模块新增导出，导致测试在加载阶段失败；改为保留真实导出后测试通过。
- `pnpm check` 通过（0 新增 TypeScript 诊断）；`pnpm build:cn`、`pnpm build:global` 通过；OpenCraft 同步只读检查通过。
- `validate_documentation.py` 通过：0 断链、0 未分类文档、0 警告；`git diff --check` 通过。

## risks
- 无权益用户点击头像后仍可能被 `/agents` 门禁拦截；该门禁按已有产品规则执行。

## validation
- 菜单与静态导航聚焦测试、`pnpm check`、双站构建、OpenCraft 同步检查、文档和 change-impact 门禁。

## decisions
- 只改 Header 头像 `<a>` 的目标；不改变菜单触发方式。

## scan_scope
- `UserAvatarMenu`、静态导航测试、Agent 入口门禁。

## scan_output
- 精确搜索定位 Header 头像链接与两处现有测试断言。

## handoff
- 本地代码改动及前端验证完成；交由 MR 评审，未合并、未发布。
