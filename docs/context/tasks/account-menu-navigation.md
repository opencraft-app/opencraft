---
id: account-menu-navigation-task
type: task
scope: 精简登录态头像菜单并统一国际站英文入口文案。
triggers: ["avatar account menu", "My AI Companion", "头像菜单"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/account-menu-navigation.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：头像账号菜单精简

## goal

将页面右上角登录态头像菜单精简为“我的智能体伙伴”“账号管理”和底部“退出登录”，并采用自然的国际站英文文案。

## non_goals

- 不删除“我的工作台”功能或 Agent 控制台左侧导航入口。
- 不改变账号、退出登录或 Agent 路由。
- 不改变非英文 locale 的现有翻译。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-account-menu-navigation`
- 用户要求头像菜单顶部依次展示“我的智能体伙伴”“账号管理”，移除“我的工作台”，英文采用 `My AI Companion`。

## interface_refs / data_structure_refs

- `frontend/src/components/site/user-avatar-menu.tsx`：共享登录态头像菜单。
- `frontend/src/i18n/generated/en-US.json`：国际站英文显示文案。
- 不变量：`/agents/`、`/account` 路由与退出登录行为不变。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：国际站首页已使用 `My AI Companion`；头像菜单此前使用 `My AI partners`，且重复展示“我的工作台”。
- `superseded_refs`：无。

## acceptance

- 头像菜单前两项依次为“我的智能体伙伴”和“账号管理”。
- 头像菜单不再显示“我的工作台”，退出登录仍位于底部。
- 英文分别显示 `My AI Companion` 与 `Account Settings`。
- 聚焦组件测试和前端门禁通过。

## affected_paths

- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `frontend/src/i18n/generated/en-US.json`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/account-menu-navigation.md`

## required_context

- `frontend-product-surface`
- `site-environment-routing`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库提交、Context 与验证规则 | 限定修改及 MR 范围 |
| `frontend/AGENTS.md@working-tree` | 前端服务规则 | 确定组件测试与 i18n 门禁 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 双站语言与公共入口边界 | 保持路由和非英文 locale 不变 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认头像菜单属于共享前端展示层 |

## evidence

- 源码定位确认“我的工作台”仅从共享头像菜单移除，Agent 控制台左侧入口保持不变。
- 头像菜单聚焦测试 10/10 通过，覆盖前两项顺序、“我的工作台”缺席与英文词典。
- `pnpm check` 通过：i18n 与文档检查通过，TypeScript 未新增诊断。
- Documentation Validator 与 `git diff --check` 通过；Context catalog 已登记本 Task Pack。

## risks

- 全局修改“我的智能体伙伴”英文会影响其他复用该键的入口；该文案与国际站首页现有 `My AI Companion` 产品命名保持一致。

## validation

- `pnpm vitest run src/components/site/__tests__/user-avatar-menu.test.tsx`
- `pnpm check`
- `git diff --check`

## decisions

- 用户端菜单将“账号管理”译为 `Account Settings`，表达设置个人账号的动作，不使用后台管理语气。owner 为 `wisp/mono2-maintainers`。

## scan_scope

- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `frontend/src/i18n/generated/*.json`

## scan_output

- 头像菜单含 Agent、账号、个人工作台与退出登录入口；本次只移除个人工作台菜单项。

## handoff

- 本地实现与验证完成；计划并入现有 MR !3611，尚未提交或推送。
