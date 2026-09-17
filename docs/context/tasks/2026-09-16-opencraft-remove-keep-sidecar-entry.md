---
id: opencraft-remove-keep-sidecar-entry
type: task
scope: 从 OpenCraft 账户浮层移除 Keep in sidecar 可见入口，保留底层 Pin 能力。
triggers: ["Keep in sidecar", "Sidecar 入口", "账户浮层"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/shell-navigation/index.tsx
  - opencraft/docs/platform-architecture.md
status: active
reviewed_at: 2026-09-16
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: false
---

## goal
删除账户浮层中用户可见的 Sidecar placement 操作，不删除 Pin reducer、持久偏好或内部兼容路径。

## non_goals
- 不删除 Sidecar、Pin 状态模型、响应式 Dock 或既有迁移数据。
- 不调整 Sidecar、Footer、账户浮层或窗口几何。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求，2026-09-16：`Keep in sidecar` 功能不要显示，入口直接删除，代码可以保留。

## interface_refs / data_structure_refs
- `ShellNavigationFooter` 账户浮层呈现。
- `reduceShellNavigation` 与 `pin` action 保持不变。

## history_context
- Sidecar Footer 和 Pin 状态仍是当前正式模型；本次只撤销一个显式 placement 入口。

## acceptance
- 可见源码与桌面 UI 不再出现 `Keep in sidebar` / `Unpin from sidebar`。
- `pin` action 与既有内部状态路径仍保留。
- 不新增占位，不改变浮层或窗口几何。

## affected_paths
- `opencraft/apps/workbench-web/src/components/shell-navigation/index.tsx`
- `opencraft/tests/workbench-sidebar-dock.test.ts`

## required_context
- `opencraft/AGENTS.md`
- `docs/context/tasks/2026-09-11-opencraft-fixed-navigation.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | OpenCraft Vibe 与 Sidecar 边界 | 保持几何稳定 |
| `opencraft/apps/workbench-web/src/components/shell-navigation/index.tsx` | 唯一可见入口 | 只删除呈现块 |
| `opencraft/tests/workbench-sidebar-dock.test.ts` | 标准 Sidecar 回归 | 锁定入口消失、状态保留 |

## evidence
- 红测：源码仍包含 `Keep in sidebar` / `Unpin from sidebar`。
- 绿测：文案与 placement JSX 删除后，`pin` action 断言仍通过。
- `npm run test:workbench:unit`：234 项通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- macOS OpenCraft Preview 实机：账户浮层仍展示 Account、Usage、Settings 与 Sign out，不再展示 `Keep in sidebar` / `Unpin from sidebar`，浮层和窗口几何未变。

## risks
- 误删 Pin 状态会改变既有用户布局；通过保留 reducer/action 与源码断言规避。

## validation
- `workbench-sidebar-dock.test.ts` 聚焦测试。
- Workbench Web 类型检查与桌面 Preview 账户浮层检查。

## decisions
- 删除入口呈现，不删除底层能力。

## scan_scope
- `opencraft/apps/workbench-web/src/components/shell-navigation`

## scan_output
- 精确字符串检索定位到 `ShellNavigationFooter` 单一入口。

## handoff
- Complete：可见入口已删除，底层 Pin 能力保留，单测、类型检查与桌面 Preview 均已验证。
