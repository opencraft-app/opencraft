---
id: opencraft-footer-controls-2026-09-12
type: task
scope: 底部入口标准间距、容器自适应及共享图标。
triggers: ["footer controls", "账号按钮宽度", "标准化间距"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/shell-navigation/shell-navigation.scss
  - opencraft/packages/design-system/src/tokens.web.scss
status: retired
reviewed_at: 2026-09-12
review_due: 2026-12-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
按用户确认的三点统一底部按钮组：标准间距、账号填满剩余空间、同库单图标；同时修复后续截图中的越界。

## non_goals
- 不改应用切换/登录行为，不另画图标，不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- FOOTER-01：标准化间距，不临时 hardcode margin。
- FOOTER-02：左按钮方形，账号背景/点击区随侧栏剩余宽度变化，内容不拉伸。
- FOOTER-03：复用自身共享图标组件，不叠图标。
- FOOTER-04：新截图显示按钮背景越过侧栏边界，需约束实际容器。

## interface_refs / data_structure_refs
- 共享 gap-control-group / gap-sidebar-entrances token。
- Footer 的 CSS grid 使用固定入口宽度 + minmax(0, 1fr)。
- SidebarToggleIcon 是已有标题栏与底部共用的组件。

## history_context
- current_design_refs：platform-architecture 的 Sidecar Footer 归属。
- relevant_evolution：Primary motion 的 260px footerWidth 把整组错误绑在单栏；共享 portal 通配 width:100% 与 absolute left/right 冲突导致右侧越界。
- superseded_refs：叠加应用图标预览、零间距及单栏 footerWidth。

## acceptance
- 匿名/登录、固定/浮动、窄栏和扩宽均保持 token 间距与标准方形入口。
- 账号右边缘等于容器右边缘减统一 inset；名称截断，不越界。
- 拖拽中入口横坐标/大小稳定，账号跟随剩余空间；共享图标为一个 SVG。

## affected_paths
- 共享 tokens/controls、ShellNavigation、AppShell、Primary motion、状态测试。

## required_context
- frontend-product-surface 路由 must_read 与 OpenCraft 约束。

## context_receipt
- docs/context/project/services/frontend.md、opencraft/AGENTS.md：工作区与 UI 边界。
- tokens.web.scss、controls.web.scss：现有间距尺度和控件语义。
- sidebar-toggle-icon.tsx：复用已有库中几何，不新造资源。

## decisions
- Footer 宽度由整个 Sidecar 容器决定，不再由 Primary motion 计算。
- Footer 按钮组是正常文档流中的末行，relative 仅作菜单锚点，只有菜单允许浮层。移除按钮组 absolute/inline inset 与 Primary footerWidth。
- portal 的 feature 填充规则不应用到 Footer，由正常 grid/padding 确定固有高度。

## evidence
- 两张用户截图分别说明短宽度和背景溢出；代码定位与截图一致。
- 5 组真实组件浏览器验证通过：匿名/已登录/长名称、宽度变化/按住拖拽、固定浮动、窄栏、token 覆盖和账号菜单。按钮组 relative 正常流，只有菜单 absolute。
- macOS 实测 Sidecar 412→422，账号按钮 346→356；gap 保持 8，右 inset 保持 12，入口始终 34×34，单个共享 SVG，z-index 为 auto。
- 应用 gate、类型检查、独立 macOS 构建/签名检查通过。测试截图与报告位于 `/tmp/opencraft-shared-sidebar/`。

## risks
- 要同时检查 CSS 计算后的边界，不能只断言 gap 字符串。

## validation
- 真实组件测量固定/浮动/resize/长名称；应用 gate 和独立 macOS 预览。

## scan_scope
- ShellNavigation、Primary motion、共享 portal 与 design-system tokens。

## scan_output
- 用一套 group 规则解决尺寸/间距/越界，不为截图加单独补丁。

## handoff
- 已按确认范围完成并更新原独立侧栏预览；用户工作窗口未重启，未提交、推送或发布。

## stage
完成。

## verified
- Footer 错误宽度来源与 absolute overconstraint 已定位。

## unverified
- 未对真实账号执行登录或资料修改；已登录外观使用隔离数据验证。

## discard
- 不使用 margin 负值、额外固定账号宽度或复合图标。

## restore
- 保留前序共享侧栏与并行环境目录改动。

## next_action
- 用户在独立预览中验收底部布局与共享图标。
