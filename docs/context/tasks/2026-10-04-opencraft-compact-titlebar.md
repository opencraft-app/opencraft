# Compact Sidecar continuous titlebar

## goal
> 用户后续反馈延迟与缺乏横向过渡；本任务的“等 context 退出完成才换色”绘制约束已被纠正，当前整改见 [live upper-lip motion](2026-10-04-opencraft-titlebar-live-motion.md)。运行回执仍保留为历史证据。

取消边缘渐变。仅 compact-only Sidecar 下，完整标题栏统一底色，侧栏细分界从标题栏下方开始；原生窗口按钮预留区不得被侧栏窄宽切开。

## non_goals
- 不改图标、按钮、Sidecar 色彩、主面板主题阴影/描边、原生按钮位置或 safe-area 几何。
- 不新增窗口按钮，不改业务状态/内容身份/布局宽度/点击或拖拽。
- 原实现阶段不替换预览；用户后续明确“替换吧”授权本轮仅更新当前 Web 静态预览，不重启后台、不提交发布。

## requirement_refs / requirement_excerpt
用户放弃渐变并澄清是窗口红黄绿按钮保留区；确认示意图右侧“顶部连续，下面分栏”，最新“是的，这个就是我需要的”。
后续“替换吧”授权预览替换。

## interface_refs / data_structure_refs
- AppShell 从当前呈现的 primary detent 与 context layout owner 推导 compact-only；不增加持久偏好。
- Header 唯一拥有顶部绘制、窗口预留、拖动与控制区域；Sidecar 只拥有其下方边界和材质。
- Theme 独立拥有主面板 elevation；仍消费 `--codex-main-surface-elevation`。

## history_context
- current_design_refs: SHL-01–05、workbench-design-language、platform-architecture Header/Sidecar。
- relevant_evolution: 主题阴影恢复；原 native reservation 与 Header max-content 测量独立于 Sidecar。
- superseded_refs: 2026-10-04-opencraft-shell-material-edge 的全高/顶部局部渐变方案均被用户取消。

## acceptance
- 十种主题/模式：compact-only 顶部跨边界及 native reservation 连续，下面有细分界；没有残留渐变。
- expanded/带 context 与 floating 保留既有材质/阴影；context exit 结束前不误判 compact-only。
- 显隐、held resize、draft DOM 身份、safe-area controls、forced colors 回归。
- 类型检查、相关测试、真实组件浏览器验证、边界与文档影响检查通过。

## affected_paths
- opencraft/packages/design-system/src/tokens.web.scss
- opencraft/apps/workbench-web/src/components/app-shell.tsx
- opencraft/apps/workbench-web/src/styles/app.scss
- opencraft/apps/workbench-web/src/components/shell-navigation/shell-navigation.scss
- opencraft/tests/shared-control-standards.test.ts
- opencraft/scripts/smoke-shell-material-edge.ts
- opencraft/docs/workbench-design-language.md
- opencraft/docs/platform-architecture.md
- opencraft/design/invariants.md
- docs/engineering/domains/agent-gateway-runtime.md

## context_receipt
- 根/OpenCraft AGENTS、maintenance Skill/完整 verification、design/README、Task 模板此前已读；本轮复核实际 Header/Sidecar 样式与组件、window-chrome 与主题/控件邻居。
- Router `opencraft compact Sidecar continuous titlebar native controls reservation` 无匹配，按明确 Shell/DS/测试/正式设计路径 bounded exact search。
- 无生产写入、账号/凭据读取；参考 mockup 为本地 HTML/CSS，不是原生实机验收。
- 一次工具定位依赖误扩大到 /data 文件清单，已中止；改用已知 mockup renderer 中的确切浏览器路径。

## decisions
- 利用既有 Header 背景层统一顶部，不能增加盖住操作区的 root overlay。
- compact-only 依据物理 context owner 释放，不只依据 `sidebarOpen` 意图；外侧细线是零几何成本、pointer-events:none 绘制。
- 删除旧 gradient tokens，不沿用无效历史方案或禁用主题 elevation。

## risks
Header 在 main surface stacking context 中；必须用真实组件截图验证跨窄栏/native reservation 绘制，而不只检查 CSS 声明。

## validation / evidence
- shared-control-standards/appearance-theme/theme-material/window-chrome 30/30；shell-space/floating/context-geometry/sidebar-dock/controls 44/44（controls 重叠 5 例）。Web/Design System 类型检查、boundary/typography、docs-impact 和定向 diff-check 通过。
- 完整 Web 构建通过，隔离产物 `/tmp/opencraft-compact-titlebar-build-UDGJY2`，未覆盖运行包。保留既有 large-chunk/dynamic-import 构建警告，未扩展本轮处理范围。
- 真实源码 AppShell smoke `/tmp/opencraft-shell-material-edge-30RkuX`：Codex/Frost/Lavender/Vela/ZenCode 浅深十种组合，普通 browser 与模拟 macOS Electron safeArea=78 两种环境均逐像素确认标题栏顶/底扫描线跨 52px 窄栏边界完整同色，Header 1180px、native action left=84px，分界从 46px toolbar 下方开始；主题 computed shadow 与真实 theme shadow 一致（flat 保持 none）。
- 带 context 的十种主题无渐变；真实按钮/键盘切 primary detent，30 个 rAF 样本中 context layout mounted 时 compact-only 始终 false，释放后才 true。held resize 保存值不变、frame/viewport 与 main 相邻、边缘点击、零宽、forced colors、390px floating 阴影、draft DOM/mount 身份均通过；零 pageerror。已查看 browser Frost light、模拟 Electron Frost light/Codex dark 截图。
- smoke 首次因缺运行库未启动；改用机器既有浏览器依赖，无安装/系统修改。测试初版误把 navigation-only 当自动 compact、之后误以为带 context 时默认 pin；已改用真实 Applications 入口与 Resize applications Home 操作，未改产品逻辑迁就用例。
- 未在真实 macOS/iOS 验收，不把模拟 safe-area 与 Chromium 手机 viewport 当原生材质/窗口按钮实测。

## scan_scope / scan_output
明确上述路径及 workbench-window-chrome/sidebar/shell-space 测试；未读取凭据。

## handoff
源码实现及验证完成：完整标题栏单一绘制、下方细分界、无渐变；主题材质/elevation 与窗口预留几何保留。已同步正式 SHL-05 与设计文档。替换授权后以实际运行的 theme-shadow 包生成仅本轮变更的候选；不得用完整 dirty checkout 构建覆盖其他会话正在运行的新修复。

## preview checkpoint

### stage
候选包及切换后实际 80 端口浏览器验证通过；独立 systemd oneshot 已成功结束，交接完成。

### verified
- 运行 owner `opencraft-neutral-focus-20261004-preview.service`、PID 1554252、80 端口、cwd `/data/opencraft-neutral-focus-YZHpna/opencraft-server`、数据目录不变；runtime SHA256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`。
- 候选 `20261004-compact-titlebar-df515a3c692b` 基于实际 `20261004-theme-shadow-ee41bfa046c2`，旧不可变资源原字节保留；只改历史 gradient tail 与 packaged AppShellRoot/AppShell 派生字段，所有其他 JS/CSS 原字节保留。
- staging `/data/opencraft-compact-titlebar-preview-cuYnYE`；candidate-evidence 30 个真实打包组件/主题案例、native safe-area 像素、context exit、held resize、手机浮层与 draft identity 通过，零 pageerror/资源错误。隔离所有 WebSocket，未写真实 Host/模型。
- 本轮再次完整读取 maintenance/verification、自托管预览 Skill；Router 无匹配后精确检查当前 packaged CSS/JS、switch/source 和邻接静态发布测试。未读取凭据。
- `status.json` success=true，`live-evidence.json` 30 个案例通过且 manifest/旧不可变资源逐项哈希验证，零 pageerror/资源错误。已查看运行包 Frost light 截图。实际 `/version.json` 为 `20261004-compact-titlebar-df515a3c692b`、health.ok=true，PID/runtime SHA256/cwd/data-dir 未变；后台未重启，旧 Web 在 staging/web 可回滚。
- 候选测试第一次在 viewport/context 切换同一时刻触发快捷键，未等待呈现更新导致浮层验证超时；改为等待两帧并点击实际 Header 按钮通过，产品包不为测试修改。

### unverified
- 原生 Mac/iOS 仍未实测；用户真实观感待刷新确认。

### discard
- dirty 全量源码构建不用于替换；旧全高/顶部渐变验收均失效。

### restore
- staging prepare/provenance/switch/smoke；switch 前置检查 PID/cwd/runtime/基底版本/manifest/source guards，原子 exchange 后保留旧 web，运行验收失败自动交换回滚。

### next_action
用户刷新当前预览查看；无需重启后台。
