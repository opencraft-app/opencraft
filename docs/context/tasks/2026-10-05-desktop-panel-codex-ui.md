---
id: desktop-panel-codex-ui
type: task
scope: 云桌面面板的 Codex 参考视觉及交互呈现。
triggers: ["云桌面视觉", "desktop panel ui", "桌面空态"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
将已接通的桌面观看面板呈现为紧凑状态栏、完整连接/失败空态和等比画面，并验证真实浏览器。

## non_goals
不更新当前预览，不开放公网，不实现 TAT 或原生控制 executor；不宣称没有官方运行截图的逐像素复刻。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户“接入页面？视觉、交互、质感要复刻 codex可以做到吗”“继续”。

## interface_refs / data_structure_refs
DesktopViewController 是连接/控制唯一状态源；React 不重建媒体宿主；Shell 管标签/最大化；设计系统管空态尺度/排版。申请控制不等于取得控制。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、design/invariants.md、docs/engineering/domains/agent-gateway-runtime.md。
relevant_evolution：本机只读观看和有限恢复已实现、验收，未替换公网预览。
superseded_refs：旧 toolbar-only 连接/错误呈现。

## acceptance / validation
聚焦测试、相关类型检查、i18n/边界/排版检查、Web 构建；真实浏览器覆盖连接、失败重试、只读/控制、窄屏和主题，画面节点与 owner 不因反馈切换重建。

## affected_paths / scan_scope
opencraft/plugins/cloud-desktop、packages/design-system、workbench-web styles/i18n、相关 tests/scripts/docs。

## context_receipt
已读根/OpenCraft AGENTS，维护技能及 verification，Task 模板，platform-architecture 桌面边界，cloud-desktop-plugin，design/README，frontend-runtime-openspec-i18n 邻接卡及桌面真实组件测试邻居。
Router 查询 `opencraft 云桌面 面板 Codex 视觉交互 所有权` 无匹配；随后有界搜索 cloud-desktop、right-panel、测试和 i18n。registry.ts 精确路径不存在，改读真实 typography.tokens.json。
参考只读 `/data/codex-new/codex-26.930.31428-12913/unpacked/webview/assets/panel-da547d640131.js` 的 CloudDesktopPanel，以及 app-shared-e760024b6716.js 的 sMi EmptyState；版本 26.930.31428/build12913。参考的是已解包 WebView 呈现，不是可运行的 Mac 窗口。

## decisions / risks
维持后端授权、双 readiness 和确认后的控制状态，不能复制参考的乐观按钮文案为输入授权。原始错误只用于诊断，界面显示短用户文案。空态样式放设计系统，领域状态/反馈放插件，Shell 不另开桌面布局。

## evidence / handoff
实现与本轮验收完成；源码及 Web 构建在当前 checkout，未替换公网预览。紧凑状态/outline 控件、18/24 中等标题、32px 图标、居中空态、短文案、失败重试及稳定媒体 DOM 已接入。申请控制时忙状态属于 toolbar，取消按钮保持可见；初始已发现能力直接显示连接中，避免先闪不可用。
云桌面测试 85 项、排版测试 5 项、相关 plugin/DS/Web 类型检查、i18n、边界检查通过。最终初始化微调后 plugin 测试 21 项及 Web 重构建通过；构建保留既有动态导入/大包警告。git diff --check 通过。
真实浏览器主题/720px/320px 完整状态与中文切换通过，初始证据 `/tmp/opencraft-desktop-ui-YtZeqy` 截图已复核；初始化微调后最终再次通过，证据 `/tmp/opencraft-desktop-ui-lxt8wO`。真实 panel + Vela viewer/wire + noVNC 输入 grant/revoke/关闭通过，但远端 broker/executor 是合成边界，不能声明生产控制验收。
真实本机 Codex/Thread/授权/native/browser 观看与自动恢复通过，证据 `/tmp/opencraft-local-desktop-smoke-0Jib2l/desktop-acceptance.png` 已复核：1440×900，实际显示 691.1875×432、完整包含，RGBA [32,128,224,255]；第二条新授权观看流，关闭观看保留 Thread。推理仅本地合成端点，不执行 TAT。
仅临时启动已安装、disabled 的独立只读服务；最终 xvfb/observer/proxy 均 inactive/disabled，已清除 observer 自身 SIGTERM exit2 标记。本轮未重启/替换聊天服务；实际当前预览仍 buildId `20261005-ssh-discovery-recovery`，查询时 MainPID2120682，不沿用历史 PID 为当前证据。
文档检查 errors/warnings/断链为零；显式 changed-file impact 通过，合入仍需 Owner 审阅。根 context 单测 26 项有 4 个既有失败；context-audit 33 项通过，discovery 仅 needs_agent_review/not_assessed，不是完整评审。最终 catalog/context 校验 5025 个全仓错误、本 Task 错误为空，不能宣称全仓 gate 通过。

## checkpoint
stage：本轮页面实现/验收/正式文档沉淀完成；未部署。
next_action：若接入 DevCloud 公网，必须先接通真实会话/实例与用户授权，不能公开转发本机 loopback owner 入口；原生控制 executor、真实 TAT、手机弱网/输入仍未验收。
failure_receipt：首次 npm 缺少 PATH，显式使用本机 Node 后通过；第一次 Sass role 用 camelCase，被校验拒绝，改为生成的 kebab-case 后通过；第一版验收页未应用主题，截图暴露透明背景/缺少描边，改用正式主题生成器并增加颜色/描边断言。首次原生验证先着色后启动 observer 导致 X reset 黑底，调整准备顺序；随后暴露 zero-area status wrapper，将角色归到实际反馈表面后通过。并发浏览器验收暴露测试里固定 50ms 等 socket close 的竞态，改为等待本测试 peer 的有界 close 事件。Task trigger 数量不足已补齐；不掩盖失败收据。
