---
id: opencraft-shared-floating-sidebar-2026-09-12
type: task
scope: 固定和浮动 Sidecar 共用内容所有者与完整导航。
triggers: ["floating sidebar", "共享侧栏", "app sidebar parity"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/app-shell.tsx
  - opencraft/apps/workbench-web/src/components/shared-sidebar-content.tsx
status: retired
reviewed_at: 2026-09-12
review_due: 2026-12-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
浮动与固定侧栏使用同一份应用导航、上下文和底部内容，模式切换不丢状态。

## non_goals
- 不改聊天、环境 API，不提交、推送或发布。
- 不重做已有拖拽动画、不覆盖工作区其他任务改动。

## requirement_ids / requirement_refs / requirement_excerpt
- SIDEBAR-PARITY：用户截图指出浮动栏没有 app sidebar；要求一套布局的不同表现并授权整改。

## interface_refs / data_structure_refs
- SharedSidebarContent：稳定 portal 容器，两个呈现器只提供目标 slot。
- floatingSidebarLayout：独立浮层矩形预算，不使用主区域剩余宽度。
- ShellNavigationController：共享用户 detent、选中项与账户动作。

## history_context
- current_design_refs：platform-architecture 的 Sidecar 所有权和固定入口。
- relevant_evolution：旧浮动分支 contextAvailable ? leftPanel : navigation 导致互斥遗漏。
- superseded_refs：分别创建两份侧栏内容和浮动 Applications 回调固定整个侧栏。

## acceptance
- Chat/环境/Settings 与账号在浮动中可达，窄窗可收为图标栏。
- 内容只挂载一次；列表展开、输入状态、滚动位置跨模式保持。
- 浮动 Applications 控制浮层内导航，不隐式固定；标题栏仍可固定。
- 聚焦测试、真实组件浏览器测试、应用 gate 和 macOS 验收。

## affected_paths
- AppShell、FloatingLeftPanel、共享内容组件、浮层宽度投影及样式/测试。

## required_context
- frontend-product-surface 路由 must_read 和 opencraft 服务约束。

## context_receipt
- docs/context/project/services/frontend.md：路由返回的 UI 边界。
- opencraft/AGENTS.md：workspace/gate/生成层约束。
- opencraft/docs/platform-architecture.md：呈现与内容所有权。
- docs/context/project/adjacency/frontend-runtime-openspec-i18n.md：检查对应脚本测试邻居。

## decisions
- 复用同一 React/DOM 内容，通过稳定 portal 移动到容器；不复制两套有状态列表。
- 浮层单独计算两栏总宽，不足时收紧应用导航，不修改保存的宽度。

## risks
- portal 迁移需要保留滚动/焦点，隐藏节点不得参与 Tab。
- 既有动画期间仍需保留固定栏宽度预算，不能用浮动宽度写回。

## validation
- 单测/浏览器状态与 DOM 身份/类型检查/gate/macOS。

## evidence
- 源码确认旧分支遗漏 Primary Navigation，浮层 footer 又委托 dock 回调。
- 浏览器真实 AppShell fixture 验证内容挂载数始终为 1、DOM 身份不变、输入/展开/500px 滚动保持；应用入口/账号入口可用，浮动 Applications 不固定整个侧栏；深色窄窗、Escape 和再次边缘唤出通过。
- 30 项聚焦测试及最终应用 gate 退出 0；macOS 独立包签名通过。
- documentation 校验 errors=0；仓库级 context 测试 26 项仍有 4 项既有契约失败，本 Task Pack 未出现在失败项中，未修改无关文档消除它们。
- 实机浮层应用入口完整，切换环境路由成功，540px 窗口浮层宽约 327px；原工作窗口未重启。报告与截图位于 `/tmp/opencraft-shared-sidebar/`。

## scan_scope
- components/app-shell、sidecar、floating-left-panel、shell-navigation、相关单测。

## scan_output
- 图索引不含相关节点，采用有界源码检索。

## handoff
- 已实现并通过浏览器、实机与应用门禁。独立预览位于 release/sidebar-preview，未提交、推送或部署。

## stage
完成并交接。

## verified
- 根因已确认，不是 CSS 裁切。
- 浮动和固定共用一个 React/DOM 所有者，状态/滚动保持、入口完整与窄窗预算均有测试证据。

## unverified
- 未操作真实聊天发送、账号登录或云资源；此改动不涉及这些 API。

## discard
- 只向浮层补图标的局部修补方案。

## restore
- 保留所有既有账户、环境目录与创建改动。

## next_action
- 用户在独立预览中检查浮动侧栏，后续提交须得到明确授权。
