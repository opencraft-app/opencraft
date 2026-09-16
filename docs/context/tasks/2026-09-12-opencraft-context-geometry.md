---
id: opencraft-context-geometry-2026-09-12
type: task
scope: Context Pane 拖拽几何所有权和逐帧不变量。
triggers: ["context geometry", "拖拽空白", "宽度不变量"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/context-pane-geometry.ts
  - opencraft/apps/workbench-web/src/components/use-context-pane-geometry.ts
status: retired
reviewed_at: 2026-09-12
review_due: 2026-12-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
消除拖拽扩宽时外框已变宽而内容未同步的空白，统一 Context Pane 几何写入者。

## non_goals
- 不改聊天数据、环境 API、导航逻辑、主导航动画，不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- GEOMETRY-01：用户指出未同步变宽，要求用不变量/所有权机制修复。

## interface_refs / data_structure_refs
- settledContextGeometry：稳定状态 frame = viewport = committed。
- previewContextGeometry：拖拽中 viewport = max(committed, frame)，提交值保持不变。
- useContextPaneGeometry：唯一 MotionValue 写入者；取消/释放后同步父级提交值。
- 浮层只对视口施加可用窗口宽度上限，复用相同的几何源。

## history_context
- current_design_refs：platform-architecture 的 Frame/Clip/Viewport 契约。
- relevant_evolution：旧 resizeSidebar 只更新 liveSidebarWidth，finish 才更新 viewport；实测 275→335 时 viewport 仍 275，松手后才 335。
- superseded_refs：AppShell 内分散的双 MotionValue setter 与松手 effect。

## acceptance
- 每个扩宽帧内容/视口同步，收窄按已声明的 clip 策略，不改提交值。
- 松手及 pointercancel 回到一致几何；固定和浮动都验证。
- Footer 继续由整个 Sidecar 正常布局伸展，不缓存宽度。

## affected_paths
- Context geometry/model hook、AppShell 消费、浮层 viewport、测试。

## required_context
- router 无匹配，执行 bounded exact search。

## context_receipt
- opencraft/AGENTS.md：独立 workspace 与验证边界。
- opencraft/docs/platform-architecture.md：两种几何的原始约束。
- sidebar-resize-handle.tsx：pointer up/cancel 和持久化时机。

## decisions
- 多种几何投影由一个所有者生成，不强行让收窄中的 viewport 跟随 frame 重排。
- 写 MotionValue 时先扩大 viewport 再扩大 frame；收敛变小时先缩 frame，再缩 viewport。

## risks
- 逐帧约束不能用仅松手后的截图代替；浮动窗口还需要处理可用空间上限。

## validation
- 纯模型测试、浏览器逐帧/取消回归、应用 gate、macOS 预览。

## evidence
- 旧实测：拖拽中 frame=335，viewport=275；Footer 已同步，问题属于 Context geometry。
- 新浏览器实测 48 帧通过：扩宽 frame/viewport/content=335，提交值仍275；收窄 frame=240/viewport=275；松手两者240；浮动取消后恢复275。
- 同时修正外部 prop 同步的订阅顺序：几何读取器安装后再通知 owner，避免 MotionValue transform 漏写直到下次 render。
- 30 项聚焦测试、应用完整 gate 退出 0；macOS 独立包签名检查通过。
- macOS 未松手：frame/viewport/panel 275→335，真实行宽259→319，16px为正常内边距；浮动扩宽375/375，取消恢复335/335。数据 `/tmp/opencraft-shared-sidebar/native-context-geometry.json`。

## scan_scope
- AppShell、Sidecar、use-panel-animation、SidebarResizeHandle。

## scan_output
- 已定位多个宽度写入路径；此次收敛到一个 owner。

## handoff
- 已实现并通过逐帧、松手/取消与 macOS 验收。独立包位于 release/geometry-preview，原窗口未替换；未提交、推送或部署。

## stage
完成。

## verified
- 根因有源码与实际拖拽数据支持。

## unverified
- 未发送真实聊天或执行账户/云资源写操作。

## discard
- 仅修改 footer 或增加 width:100% 的方案不能解决独立 viewport MotionValue。

## restore
- 保留已有共享内容 portal、正常流 Footer 和并行目录代码。

## next_action
- 用户在几何修复独立预览中验收。
