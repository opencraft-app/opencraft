---
id: opencraft-window-space-2026-09-11
type: task
scope: OpenCraft 双栏 Sidecar 的可逆窗口空间分配与桌面预览验收。
triggers: ["OpenCraft window space", "Sidecar responsive", "narrow window"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/workbench-runtime/src/shell-space.ts
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-11
review_due: 2026-12-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
让 OpenCraft Web/Electron 在窗口变窄时保持主工作区可用，学习 Codex 的可逆响应式呈现并适配双栏 Sidecar。

## non_goals
- 不修改账号、Host、Thread、工具会话生命周期，不发布生产。

## requirement_ids / requirement_refs / requirement_excerpt
- SPACE-01：用户截图中的窄高窗口不能让导航保留大片空白而挤压 Composer。
- SPACE-02：用户要求参考 Codex 思想，保留 OpenCraft 的额外 Applications 栏差异。
- SPACE-03：缩窄与恢复保持保存的栏宽、Pin、显式手动关闭；收起后功能仍可访问。

## interface_refs / data_structure_refs
- `resolveShellSpace`：纯窗口预算；主区 480px、普通工具栏 320px、恢复余量 32px。
- `ShellNavigationState` 仅保留用户意图，`ShellPresentationContext` 把实际状态提供给顶栏与工具控制。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md` 的 Sidecar Frame/Clip/Viewport 契约。
- relevant_evolution：Codex 本地 bundle 对右栏临时隐藏/恢复、手动侧栏优先、浮动恢复入口分别处理。
- superseded_refs：OpenCraft 以 720/960 整窗断点和单个 sidebarOpen 推断双侧栏预算。

## acceptance
- 双侧栏宽度、右栏开关、无上下文路由组合保持主区预算。
- 窄屏工具入口可全宽打开，侧栏可浮动打开；顶栏与焦点反映实际呈现。
- Electron Preview 实际窗口缩放、恢复、手动开关及设置/登录入口验收。

## affected_paths
- `opencraft/packages/workbench-runtime/src/shell-space.ts`
- `opencraft/packages/workbench-panels/src/model.ts`
- `opencraft/apps/workbench-web/src/components/`
- `opencraft/tests/`

## required_context
- `opencraft/AGENTS.md`、`opencraft/docs/platform-architecture.md`、`opencraft/docs/build-matrix.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | 共享包变更 | gate 与独立构建约束 |
| `opencraft/docs/platform-architecture.md` | Sidecar 设计 | 保持单一几何与运行时所有者 |
| `opencraft/docs/build-matrix.md` | mac 预览 | 独立 preview 产物 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计映射 | 同步窗口预算契约 |

## evidence
- 聚焦布局/导航/拖拽测试首轮 34 项通过；Web typecheck 通过。
- 最终 `npm run gate` 退出 0：859 项测试通过，Web / Expo Web / iOS bundle 构建完成。
- Electron packaged live：1800/1500/1200/1100/1000/700/540px 缩放及恢复、Applications peek、浮动 Sign in、工具 Back to chat、手动关闭、按住拖拽提交、Settings 浮动共 16 条记录通过；pageerror 为 0。
- Preview ZIP strict deep codesign 与 unzip 完整性通过；文件摘要保存在本地报告。
- 本地报告 `/tmp/opencraft-shell-space/report.html`，实测 `/tmp/opencraft-shell-space/report.json`，尺寸截图同目录。
- 本地 node-pty spawn-helper 缺执行位，修复依赖文件权限后 process RPC 和完整 gate 通过；未改运行时源码绕过测试。
- 文档分类、change-impact 通过；context-audit 单测 33 项通过；附加 context 单测 26 项中 4 项因其 validator 文档扫描结果失败。

## risks
- 自动降级与手动拖拽/显式关闭必须区分；动画不可制造第二个几何写入者。

## validation
- 新增空间矩阵测试、原有侧栏/面板测试、npm run gate。
- macOS Preview build、真实 Electron 几何与交互、文档和 change-impact。

## decisions
- 降级顺序为 Applications expanded → compact → hidden → right hidden → context floating。
- 自动降级保留用户意图；窄态工具显式打开可使用工作区全宽。

## scan_scope
- shell-space、shell-navigation、AppShell、right-panel 与 Codex 本地 bundle。

## scan_output
- context router `opencraft` 无匹配；有界精确源码检索命中已知布局文件。
- graphify 已有图仅覆盖 Electron 宿主，不作为 renderer 策略依据。

## handoff
- 实现与 Electron 验收完成；提供本地 macOS Preview，尚未提交或发布。

## stage
最终预览交接。

## verified
- 完整 OpenCraft gate、16 条 Electron 实测记录、ZIP 与签名。

## unverified
- 真实 Web OIDC 登录仍不属于本次布局测试；仓库附加 context 告警需单独处理。

## discard
- 被后台窗口节流影响的中间定时测量不作为最终证据，最终回归同时等待空间总和与主区预算稳定。

## restore
- 最终产物位于 `opencraft/apps/workbench-electron/release/preview/`；先前匿名登录改动仍与本次修改共存。

## next_action
- 用户直接预览和反馈；提交或发布按后续指示执行。

## Follow-up: Applications 再窄四分之一
- goal：默认 182px → 137px，仅收窄 Applications，不改上下文栏宽度与主题。
- non_goals：不修改云实例创建入口、不批量清空已保存宽度、不提交或发布。
- context_receipt：补读 `docs/context/project/services/frontend.md` 与
  `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`；邻接测试为
  `opencraft/tests/workbench-shell-navigation.test.ts`。路由命中 frontend 是
  navigation 关键词，实际变更仅位于 OpenCraft 独立 workspace。
- implementation：默认宽 137px、展开下限 126px，拖拽与键盘共用 Applications
  下限，不再误用上下文栏的 240px 下限；保留已有自定义宽度。
- validation：完整 `npm run gate` 退出 0，889 项测试通过；Electron release
  构建、Preview 打包、strict deep codesign 与 ZIP 完整性通过。
- verified：mac 预览通过分隔条双击恢复 137px；键盘依次落在
  127/126/136px、拖拽落在 152px、再次双击回 137px，过程不改变上下文栏。
  Chat/环境/Settings 文字完整，Footer 应用按钮仍为 34px 正方形，pageerror 0。
- checkpoint：预览重启后上下文栏读取默认 275px，已通过现有键盘控件恢复
  重启前的 240px；未改写上下文默认值或增加宽度迁移。当前两栏为 137/240px。
- evidence：本地截图 `/tmp/opencraft-narrow-preview.png`，回归结果
  `/tmp/opencraft-narrow-report.json`；正式设计同步补充
  `docs/engineering/domains/agent-gateway-runtime.md`，change-impact 通过。
- handoff：本次缩窄完成，未提交或发布；LightVela 创建占位入口仍为独立待办。

## Follow-up: Applications 展开与收起对称动画
- goal：修复应用入口取消选中时瞬间消失，保留连续反向与拖拽边界。
- non_goals：不调整既有弹簧参数，不替换 Motion，不改变账号、路由或栏宽偏好。
- context_receipt：沿用上文 Sidecar 正式设计；路由 `opencraft Sidecar animation`
  无 pack 命中，精确查阅 app-shell、use-panel-animation、use-sidecar-primary-motion
  与 sidecar 样式、workbench-sidebar-dock 测试。
- reproduction：mac 按钮收起 126→0 无中间帧；展开存在 37 个中间帧。
- cause：隐藏投影 railWidth=0 被基础几何同步 effect 提前写入 frameWidth；
  可见性进度乘零导致退出动画被消除，并非弹簧时长问题。
- ownership：不可见期间保留基础几何，显隐进度负责退出；内容沿用末次快照，
  立即 inert，终点卸载；拖拽已落零的隐藏保持零，不反弹。
- validation：完整 gate 退出 0，890 项测试通过；mac release/Preview 构建、
  strict deep codesign、ZIP 完整性通过。
- verified：独立 mac profile 的 Settings 页面展开/收起分别有 36 个中间帧；
  80ms 反向点击连续恢复展开，退出过程内容保留且 inert，终点卸载；Footer
  锚点不变。减少动态效果模式直接落点并正确卸载。共享窗口另有 37 帧双向证据。
- evidence：可重复脚本 `opencraft/scripts/smoke-primary-visibility.mjs`；独立
  验收报告 `/tmp/opencraft-toggle-isolated-settings.json` 与
  `/tmp/opencraft-toggle-isolated-reduced.json`。
- discard：早期脚本受 tsx 注入的函数名 helper 影响，改用原生 mjs；共享窗口
  追加测试混入尺寸/折叠状态变化，不作为验收依据，以独立 profile 结果为准。
- unverified：设置深链接的页面重载曾出现空内容，本次脚本从桌面根入口进入；
  不将该独立重载问题视为已修复。
- handoff：预览已更新；独立测试进程已关闭，不操作用户当前窗口。未提交/发布。

## Follow-up: Applications 内容宽度上限
- goal：当前默认展开宽 137px 同时作为最大宽，仍允许缩窄、compact、hidden。
- non_goals：不限制上下文栏，不新增动画或 CSS 裁切补丁，不发布/提交。
- context_receipt：路由 `opencraft application rail maximum width` 无匹配；精确
  搜索 shell-navigation、app-shell 与 primary resize handle 的旧 520px 上限，
  核对邻居 workbench-shell-navigation/workbench-sidebar-dock 测试；沿用上文设计。
- implementation：共享 expandedMaximumWidth，统一保存值归一化、投影、持针帧、
  释放目标和键盘 End；正常保存宽度保留，过宽历史值读为 137px。
- validation：37 项聚焦测试、workbench-runtime typecheck、平台边界与 diff
  检查通过；正式设计 change-impact 通过。
- blocked：完整 gate 在另一组环境创建改动处 typecheck 失败：
  `environments-page.tsx` 的 getUrl 与当前 viewId 合约不一致，
  `lightvela-environment-view.tsx` 使用未支持的 info tone。未触碰这些文件。
- unverified：未打包或替换当前 mac 预览，尚未进行新上限的桌面逐帧验证。
- checkpoint：本次源码上限已完成，待环境创建改动恢复一致后跑 gate、构建
  和独立预览；本地 `/tmp/opencraft-cap-smoke.mjs` 为待执行持针/键盘验收脚本。
- handoff：未提交、未发布，当前已运行预览仍是上轮动画修复版本。
