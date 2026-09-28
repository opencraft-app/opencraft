---
id: 2026-09-20-sidebar-account-hit-area
type: task
scope: 扩大 Agent 桌面侧栏左下角账户菜单的可点击区域。
triggers: ["sidebar account hit area", "用户头像菜单", "账户区域点击"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - frontend/src/styles.css
  - frontend/src/components/site/sidebar-user-menu.tsx
status: retired
reviewed_at: 2026-09-22
review_due: 2026-12-20
revision: 1.1.0
precedence: task
derived: false
---

## goal

侧栏账号头像、文字、箭头与空白共同触发同一菜单。

## non_goals

不独立扩大页面业务或依赖改动。

## requirement_ids / requirement_refs / requirement_excerpt

本会话 2026-09-20 账号命中区域请求；当前交付按 2026-09-21-sidebar-master-merge.md 的最新收敛范围。

## interface_refs / data_structure_refs

SidebarUserMenu 的单一 button；styles.css 中 menu/trigger 均 width:100%。

## history_context

- current_design_refs: frontend/src/components/site/sidebar-user-menu.README.md。
- relevant_evolution: 原菜单根节点固定 220px，现填满父内容区。
- superseded_refs: 本文旧测试与交接结论不适用于当前 head；以合并收敛 Task Pack 为准。

## acceptance

账号行各子元素点击打开、hover 不打开、Escape 归还焦点；真实像素范围待浏览器验收。

## affected_paths

frontend/src/styles.css、frontend/src/components/site/sidebar-user-menu.tsx 及测试。

## required_context

frontend/AGENTS.md、frontend-runtime-openspec-i18n。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| frontend/AGENTS.md | UI 约定 | 复用 Popover |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接 | 样式与交互测试 |

## evidence

当前验证记录统一见 2026-09-21-sidebar-master-merge.md，删除旧独立验证声明。

## risks

组件测试无法证明浏览器像素命中区域。

## validation

sidebar-user-menu.test.tsx 与 agent-settings-nav-spacing.test.ts 纳入当前聚焦回归。

## decisions

不叠加点击覆盖层，复用原 Radix 触发器。

## scan_scope

侧栏账号行与样式。

## scan_output

根节点和 button 均填满父内容区。

## handoff

本记录退役，后续状态统一维护于合并收敛 Task Pack。
