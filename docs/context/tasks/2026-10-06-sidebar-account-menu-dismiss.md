## goal
让 Agent 侧栏左下角账号菜单在鼠标离开触发区与菜单后收起，并在点击菜单外部时收起。

## non_goals
- 不改账号、套餐、积分数据及目标路由。
- 不改顶部头像菜单或移动端导航布局。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-06 截图反馈：账号菜单 hover 打开后，鼠标离开菜单区域或点击外部应隐藏。
- 现有合并请求：!5036。

## interface_refs / data_structure_refs
- `SidebarUserMenu` 的受控 `open`、`onOpenChange`；Radix Popover Portal；嵌套语言 Popover。
- Escape 关闭时仍须归还触发按钮焦点；子语言菜单先关闭自身。

## history_context
- current_design_refs: `frontend/src/components/site/sidebar-user-menu.README.md`。
- relevant_evolution: !5036 已包含侧栏账号菜单的移动端入口和 Bot 选择器尺寸调整；本次修复继续更新同一分支。
- superseded_refs: 无。

## acceptance
- 从账号按钮移动到菜单（包括跨越间隙）保持打开；离开后收起。
- 点击菜单外部收起；嵌套语言菜单与 Escape 行为保持正常。
- 聚焦测试、`pnpm check`、前端构建、OpenCraft 同步检查及差异检查通过。

## affected_paths
- `frontend/src/components/site/sidebar-user-menu.tsx`
- `frontend/src/components/site/sidebar-user-menu.README.md`
- `frontend/src/components/site/__tests__/sidebar-user-menu.test.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`

## required_context
- 路由查询 `frontend Agent sidebar account menu hover mouse leave outside click dismiss` 未命中 Pack；在 `frontend/src/components/site` 进行了有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`（本轮用户提供） | 仓库门禁 | 限定范围和验证 |
| `frontend/AGENTS.md` | 前端服务规则 | 确定测试、检查、构建及同步门禁 |
| `frontend/src/components/site/sidebar-user-menu.tsx` | 当前实现 | 定位 hover 仅打开与 Portal 边界 |
| `frontend/src/components/site/sidebar-user-menu.README.md` | 现有交互说明 | 更新过时的 click-only 描述 |
| `frontend/src/components/site/__tests__/sidebar-user-menu.test.tsx` | 组件行为 | 覆盖离开、外部点击与嵌套菜单 |
| `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx` | 入口集成行为 | 更新过时的离开后仍打开断言 |

## evidence
- 修复前聚焦测试：鼠标离开后菜单仍显示，1 失败、1 通过。
- 修复后组件测试：21 通过；头像菜单聚焦测试：1 通过。
- `pnpm check`：166 个既有 TypeScript 诊断，基线 171，新增 0。
- `pnpm build:cn` 与 `pnpm build:global` 均通过；OpenCraft 的 130 个 Agent Console 文件同步检查通过。
- 文档验证：断链 0，未分类文档 0；`git diff --check` 通过。

## risks
- 鼠标跨过按钮与 Portal 菜单的 8px 间隙可能误关；180ms 延迟及重新进入时取消计时。
- 嵌套语言菜单也通过 Portal 渲染；在其浮层上取消父菜单的关闭计时。

## validation
- 已完成：最终聚焦测试、`pnpm check`、国内和国际构建、OpenCraft 同步检查、`git diff --check`、文档验证。
- 待完成：staged 变更影响检查，以及提交后的远端 MR 和 CI 快照。

## decisions
- 沿用现有受控 Radix Popover 和默认外部点击行为，仅增加 hover 离开计时；不引入额外全局事件监听。

## scan_scope
- `frontend/src/components/site/sidebar-user-menu*` 与相关测试。

## scan_output
- 有界搜索定位当前实现与过时测试断言；未产生独立扫描文件。

## handoff
- 本地修复与门禁已完成，下一步更新现有 MR !5036；不合并或发布。

## checkpoint
### stage
- 本地验证完成，进入提交与远端核验。
### verified
- 账号菜单离开后关闭、点击外部关闭、跨入语言子菜单保持打开的聚焦测试通过。
- 国内站与国际站构建、前端检查、OpenCraft 同步检查和文档检查通过。
### unverified
- 本次提交后的远端分支 SHA、MR 可合并状态和 CI 快照。
### discard
- 修复前“鼠标离开后仍打开”的旧断言。
### restore
- 工作树：`codex/mobile-account-menu`；目标 MR：!5036；仅五个本次文件暂存。
### next_action
- 提交、普通推送，并核验远端分支及 MR。
