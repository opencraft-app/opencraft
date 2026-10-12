---
id: opencraft-sidebar-topology-history-20261011
type: task
scope: OpenCraft 统一外侧栏拓扑的有界历史。
triggers: ["opencraft-sidebar-topology-history-20261011 history", "2026-10-11-opencraft-sidebar-topology history", "2026-10-11-opencraft-sidebar-topology handoff"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/design/invariants.md
status: retired
reviewed_at: 2026-10-13
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

# OpenCraft 统一外侧栏拓扑

## goal / requirement_refs

用户要求将最外侧栏替换为 Codex 参考的拓扑：全局入口、当前应用内容与固定账户页脚处于同一侧栏。

## non_goals

不修改 Host/Thread 身份、认证、数据库或业务菜单，不新增另一份宽度或显隐状态。

## interface_refs / history_context

`opencraft/apps/workbench-web/src/components/app-shell.tsx` 和 `components/shell-navigation/` 负责统一布局；`opencraft/packages/workbench-runtime/src/shell-navigation.ts` 负责状态投影。参考仅用于页面拓扑，稳定数据身份仍服从平台设计。

## decisions / acceptance

共享 Shell 保持一个 Sidebar 宽度与显隐 owner。全局 Start 和 Tasks 入口放在应用列表上方，账户在底部；应用线程树位于中间。关闭重复入口。固定、浮动和紧凑呈现消费同一模型，路由或尺寸变化保留内容状态。

## context_receipt

读取根与 OpenCraft AGENTS、维护 Skill、验证清单、平台架构和设计不变量；有界检查 Shell、Sidebar 和相邻导航测试，沿用共享控件与主题 token。

## validation / evidence

相关 Shell 导航和几何测试、Web 类型检查、边界检查与构建通过。真实 Web 观察统一侧栏、Tasks 路由与手机宽度；未以此声称 Electron 实机验收。原始预览验证与 Git 合入分开记录。

## risks / handoff

保留当前会话、任务关系与原生执行状态。最终 Git 交付见 `docs/context/tasks/2026-10-13-opencraft-mobile-header.md`；本记录退出默认路由。
