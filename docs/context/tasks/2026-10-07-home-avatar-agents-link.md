## goal
让公开站点首页右上角的登录用户在资格确认后通过头像图片进入 `/agents`，其余状态仍可进入账号页。

## non_goals
- 不改头像旁箭头、菜单“账号”入口、Agent 侧栏头像或 `/agents` 权益门禁；不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 确认：头像当前跳转账号页，并要求改为 `/agents`。
- MR !5052 CR 指出无套餐用户会在 `/agents` 门禁处被送回首页；按入口资格判断为头像提供账号页回退。

## interface_refs / data_structure_refs
- `UserAvatarMenu` 的 `header` 变体中头像链接；资格确认后使用 `AGENTS_HOME_PATH`，其他状态使用 `/account`。
- 菜单内“账号”仍指向 `/account`，`NextAgentEntitlementGate` 继续处理直接访问 `/agents` 的资格。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: 当前头像链接为 `/account`，箭头按钮展开菜单，菜单另有独立“账号”入口。
- superseded_refs: 无。

## acceptance
- 已确认有套餐或 Bot 资格时点击 Header 头像图片进入 `/agents`；资格未确认或不存在时进入 `/account`。
- 箭头仍可展开菜单；菜单“账号”仍进入 `/account`。
- 保持原生 `<a>` 导航和现有权益门禁。

## affected_paths
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `frontend/next-site/__tests__/static-navigation.test.tsx`
- `frontend/src/components/site/__tests__/sidebar-user-menu-controller.test.tsx`
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
- Header 头像链接按 `canShowMyAgentsEntry` 在 `/agents` 与 `/account` 间分流；国内与国际侧栏测试各 15/15 通过，头像与菜单聚焦测试 10/10 通过。
- 静态导航测试原有的两个整模块 mock 缺少模块新增导出，导致测试在加载阶段失败；改为保留真实导出后测试通过。
- `pnpm check` 通过（0 新增 TypeScript 诊断）；`pnpm build:cn`、`pnpm build:global` 通过；OpenCraft 同步只读检查通过。
- `validate_documentation.py` 通过：0 断链、0 未分类文档、0 警告；`git diff --check` 通过。

## risks
- Bot 列表未完成且只有 Bot 能证明资格的账号暂时看到 `/account`；列表完成后头像目标更新为 `/agents`。

## validation
- 菜单与静态导航聚焦测试、`pnpm check`、双站构建、OpenCraft 同步检查、文档和 change-impact 门禁。

## decisions
- Header 头像与菜单智能体入口共用资格判断；无资格时头像继续进入账号页，不改变菜单触发方式。

## scan_scope
- `UserAvatarMenu`、静态导航测试、Agent 入口门禁。

## scan_output
- 精确搜索定位 Header 头像链接与两处现有测试断言。

## handoff
- 本地代码改动及前端验证完成；交由 MR 评审，未合并、未发布。
