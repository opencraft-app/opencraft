# Shell adjacent material transition

## goal
> 历史任务：用户已取消全部渐变方案，当前目标与验证见 [compact continuous titlebar](2026-10-04-opencraft-compact-titlebar.md)。以下保留历史回执，不再作为当前设计/验收目标。

仅将用户截图红框中顶部工具栏的 Sidecar/主内容交界改为柔和底色过渡；正文与 Footer 不绘制此效果。

## non_goals
- 不改变导航、会话、布局宽度、拖拽或点击行为。
- 不重启后台、不提交或发布；仅按后续“替换吧”授权更新当前 Web 预览。
- 不移植 Memoh 的导航功能。

## requirement_refs / requirement_excerpt
- 当前会话截图红圈与“过渡颜色”；用户确认主题/Shell 所有权方案并授权实现。
- 后续“替换吧”授权前端预览替换，保留实际运行版本的其他修复与数据。
- 首次替换后用户纠正“绝大部分不要有这个效果，只需要一小块”，并圈出顶部工具栏；整条竖边的过渡不是验收目标。本轮收窄同一预览修正范围。

## interface_refs / data_structure_refs
- Sidecar aggregate MotionValue width 是交界唯一几何源；无新增状态。
- Theme engine 已提供 sidebar material、`--color-surface` 端点与 `--codex-main-surface-elevation`；局部过渡不能另设全局 docked elevation owner。

## history_context
- current_design_refs: platform-architecture Sidecar continuous material；workbench-design-language；SHL-01–04。
- relevant_evolution: continuous Sidecar 材质已实现，主内容仍投影 elevated surface 的阴影/描边。
- superseded_refs: 无。

## acceptance
- 浅、深与扩展主题中仅顶部工具栏交界渐变，像素端点与主题主表面一致；正文/Footer 像素与禁用渐变的控制组相同。
- 真实 AppShell 的布局/内容身份/输入草稿不变；拖拽实时跟随，收起无残留。
- 窄屏浮动侧栏仍有阴影，过渡不拦截输入；强制颜色保留系统边界。
- 相关类型检查、聚焦测试、真实组件浏览器验证、边界与变更影响检查通过。

## affected_paths
- opencraft/packages/design-system/src/tokens.web.scss
- opencraft/apps/workbench-web/src/components/shell-navigation/shell-navigation.scss
- opencraft/apps/workbench-web/src/styles/app.scss
- opencraft/tests/shared-control-standards.test.ts
- opencraft/scripts/smoke-shell-material-edge.ts
- opencraft/docs/workbench-design-language.md
- opencraft/docs/platform-architecture.md
- opencraft/design/invariants.md
- docs/engineering/domains/agent-gateway-runtime.md

## context_receipt
- 根与 OpenCraft AGENTS；opencraft-maintenance Skill 与完整 verification 清单：授权、Shell/主题分层、真实客户端证据。
- 根 Router 无匹配，先对 app.scss/sidebar/app 做 bounded exact search。
- sidecar.tsx、shell-navigation.scss、app-shell.tsx、theme-engine.ts、tokens.web.scss：确认单一背景/宽度来源。
- design/README、platform-architecture Sidecar 部分、workbench-design-language、invariants：正式所有权。
- adjacency/frontend-runtime-openspec-i18n 已读；不触及 frontend；检查实际邻居 workbench-appearance-theme/shared-control-standards 与 smoke-shared-sidebar。
- TASK-TEMPLATE 与 change-impact 映射已读。
- 未命中路径：packages/app-shell、packages/workbench-shell、styles/sidecar、components/shell-navigation.scss；通过有界 rg --files 与准确选择器定位实际路径，不全仓扫描。
- 替换阶段完整读取 opencraft-self-hosted-preview Skill；以正在运行的 disclosure 版本为基底，仅替换 Web 静态资源，由独立 systemd oneshot 执行原子切换并保留回滚，不停止当前执行宿主。
- 局部范围修正再次完整读取根/OpenCraft AGENTS、maintenance Skill/verification、self-hosted-preview Skill、design/README；路由器因 header 命中 frontend-service-detail，已读取服务卡并确认不触及 frontend；读取对应邻接卡并复查实际主题测试邻居。精确搜索本次 tokens/Sidecar/静态测试/smoke/正式设计路径，无扩大扫描。

## decisions
- 16px 渐变作为 Sidecar 背景图层，避免伪元素盖住文字与命中区，也无需新增服务/状态。
- 用户纠正后，绘制矩形高度消费工具栏高度 token，而不是 Sidecar 的 100% 高度；这是绘制范围，不新增 Header 状态或业务分支。宽度与背景语义不变。
- 原“docked 主内容取消描边/阴影”决策已被用户纠正：主题原有柔和阴影/细描边/平面效果是独立权威，删除本轮 `--elevation-shell-docked-content: none` 与高优先级相邻选择器；floating 阴影不变。
- 不把主题色或像素值散入业务组件；透明起点兼容原生材质，实色终点消费主题主表面。

## risks
- CSS 顺序可能让原 main elevation 盖回交界；浏览器 computed 与像素采样验证。
- 半透明材质、footer/header 连续性、零宽背景裁切和强制颜色需单独验收。

## validation / evidence
- Web 与 Design System 类型检查通过。
- shared-control-standards、workbench-appearance-theme、theme-material-capabilities 共 16/16；shell-space、sidebar-dock、floating-sidebar-layout、context-pane-geometry 共 39/39 通过。
- `npm run check:boundaries`（含 typography）通过，Web Vite 构建通过；原有 large chunk、静态/动态导入与 new URL 警告保留，不作为本轮缺陷归因。
- 显式本轮路径的 docs-impact 与 `git diff --check` 通过；未 staged/commit。
- 真实 AppShell 浏览器 smoke 已通过八种主题/模式像素采样：在 header/body/footer 三条扫描线上，侧栏末像素与主表面差不超过 2，主区不被额外覆盖，颜色单调衔接，主题端点同色时不人为制造分界。
- 同一真实组件验证 paint-only baseline 的几何完全相同、边缘按钮可点、held resize 反向跟随且松手前不改偏好、强制颜色系统线、收起为零、手机浮层保留阴影、草稿 DOM/内容/挂载次数不变、navigation-only 无额外硬线。
- 修正的验证问题：首次补丁匹配了文件较早的同名背景声明，被回归测试阻止后移至 Sidecar；边缘点击先落入原有 8px resize hit target，改测渐变内/命中区外；navigation-only 断言须等待原两栏退出 owner 释放。移动截图另等待实际 opacity=1，不把进入帧当作最终视觉。
- 尚未在真实 iOS 或 macOS Electron 原生材质中验收；浏览器模拟手机不能证明原生 vibrancy。
- 最终浏览器回执与截图在 `/tmp/opencraft-shell-material-edge-YOTm0k`；真实组件隔离 URL `http://127.0.0.1:33005`，完成后已关闭。已查看 light/dark/Lavender 及等待浮层 opacity=1 的手机截图；没有真实 Host 或模型写入。
- 预览阶段基底是实际运行的 `20261004-disclosure-d017acfc338e`，不是旧 thread-menu 包或整个脏工作树构建。从本次三个源文件提取并编译局部 CSS，保留既有 JS 修复与所有旧不可变资源，新资源使用独立 namespace。
- 候选包与实际 80 端口均完成浏览器验证：未注入的实际页面 computed 渐变/无竞争阴影；实际打包 AppShell 的八主题三条像素扫描线、held resize、收起为零、手机浮层阴影、草稿 DOM/内容不变；零 pageerror/缺失资源。测试隔离所有 WebSocket，未写真实 Host 或模型。
- 打包 smoke 首次手机浮层检查超时，原因是 viewport 变化尚未经浏览器帧提交就触发快捷键；等待两帧后候选与 live 均通过。只调整测试时序，没有修改应用行为来迎合测试。
- 替换回执 `/data/opencraft-material-edge-preview-Noionp/status.json`，候选/live 回执分别为同目录 `candidate-evidence.json`、`live-evidence.json`；实际页面与 light/dark/手机浮层截图已查看。
- 独立 `opencraft-material-edge-20261004-cutover.service` oneshot 成功（ExecMainStatus=0）。实际 build ID/HTML meta 为 `20261004-material-edge-d62a11d3c3db`，健康接口 200/ok。80 端口 MainPID 仍为 `1554252`，unit/cgroup/cwd/ExecStart 与 data-dir 不变；runtime SHA-256 仍为 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`。
- 实际 Web manifest 和旧资源逐项哈希验证通过；新 CSS 返回 immutable，入口/version 返回 no-store；旧 Web 完整保留在 staging 的 `web` 目录可回滚。

### 局部范围修正
- 以上首次整边像素/部署回执是历史证据，不再作为当前视觉目标。正式 SHL-05 与设计文档已改为仅工具栏交界。
- 16/16 相关聚焦测试、Web/Design System 类型检查与 boundary/typography 检查通过；Sass 候选编译、显式本轮 docs-impact 与 `git diff --check` 通过。
- 源码真实 AppShell smoke 在 `/tmp/opencraft-shell-material-edge-1Ne59R`，八主题/模式均通过顶部融合、正文/Footer 与无渐变控制组逐像素相同、几何不变、held resize、强制颜色、收起/手机浮层/草稿身份回归；浅/深截图已查看。
- 当前隔离候选 `/data/opencraft-local-edge-preview-4VECy5`，以正在运行的 `20261004-material-edge-d62a11d3c3db` 为基底，仅追加来源明确的工具栏高度与背景大小声明，保留所有先前 JS/运行时/资源。
- 该候选验证后、切换前检测到其他会话已将实际预览升级至 `20261004-disclosure-pixel-3aefaa3a6652`；旧切换在写入前被 buildId 前置检查拒绝，未覆盖任何当前文件。旧候选保留为历史，不当作当前回滚包。
- 重新基于最新 disclosure-pixel 包在 `/data/opencraft-local-edge-preview-tdF0FI` 准备同一两条 CSS 修正，保留新增折叠高度修复。候选与实际 80 端口的八主题局部像素/正文 Footer 负例、held resize、手机浮层、草稿 DOM 与旧资源哈希均通过；无 pageerror/缺失资源，无真实 Host/模型写入。
- 最新独立切换 `opencraft-local-edge-rebased-20261004-cutover.service` 成功，buildId/HTTP 为 `20261004-local-edge-cfe65f910d12`，健康 200/ok。MainPID/80 端口仍为 `1554252`，unit/cgroup/cwd/runtime 哈希与 data-dir 未变；后台没有重启。实际页面截图已查看，旧 Web 保留在新 staging 的 `web` 目录。

### 主题阴影回归修正
- 用户进一步否定矩形局部过渡观感并指出某些主题阴影丢失；先撤销阴影覆盖，新的二维过渡方向待样例确认，不直接更新运行预览。
- Router 查询 `opencraft shell material theme elevation regression` 无匹配；有界精确检索两个 elevation token 和当前 main selector，读取主题投影、邻居 theme-material-capabilities 测试、正式 Sidecar 设计、AGENTS 与 maintenance/verification。仅只读当前包 CSS/version，未替换预览。
- 当前运行的 `20261004-local-edge-cfe65f910d12` CSS 保留原 `box-shadow:var(--codex-main-surface-elevation)`，但本轮高优先级 `.app-shell-sidecar+.main-content-surface` 将其改为 `var(--elevation-shell-docked-content)`，而后者为 none。主题声明未丢，是消费者被错误覆盖。
- 源码已删除上述新增 token 与覆盖选择器，恢复原主题唯一控制；静态回归禁止该覆盖重现。没有实现尚未确认的新过渡视觉。
- 16/16 聚焦测试、Web/Design System 类型检查与 boundary/typography 通过；真实组件 smoke `/tmp/opencraft-shell-material-edge-kjv5pD` 验证 Codex/Frost/Lavender/Vela/ZenCode 的浅深共十种组合，computed shadow 与主题声明逐项相同，有阴影主题不归零、flat 主题不被强制添加阴影。正文/Footer 无额外渐变、held resize、显隐/手机浮层/草稿身份均通过，零 pageerror；已查看 Frost light、Codex dark、Zen light 截图。
- 旧“no seam”/所有主题 shadow=none 的断言错误地把实现当产品要求，已删除；现在验证主题 shadow authority，不能为了端点像素相等抹掉用户原有主题层次。
- 源码修正阶段未替换预览；用户随后明确“替换”，仅授权本次阴影恢复，未确认新的二维过渡造型。真实 iOS/macOS 仍未验收。
- 本次完整读取 self-hosted-preview Skill，核对实际 port/PID/unit/cgroup/cwd/runtime/data-dir；以当前 `20261004-local-edge-cfe65f910d12` 准备隔离包 `/data/opencraft-theme-shadow-preview-CQhRZP`。新活动 CSS 仅移除上次的相邻 shadow 覆盖与 none token，其余 JS/视觉/旧不可变资源保留。
- 候选与切换后真实 80 端口均通过十种主题/模式 shadow authority、正文/Footer 无额外渐变、held resize、显隐/手机浮层/草稿 DOM 身份验证，零 pageerror/资源错误；完整 Web manifest 与旧资源逐项哈希通过。浏览器隔离 WebSocket，未向真实 Host/模型写入。
- 独立 `opencraft-theme-shadow-20261004-cutover.service` 切换成功（Result=success/ExecMainStatus=0）；实际 HTTP buildId 为 `20261004-theme-shadow-ee41bfa046c2`，健康接口 200/ok。80 端口仍为 MainPID `1554252`，unit/cgroup/cwd/ExecStart/data-dir/runtime SHA 保持不变，后台未重启。
- 候选/live 回执与截图在该 staging，旧 Web 完整保留于 `web` 可回滚；`status.json` 为成功切换证据。顶部过渡仍是此前版本，未实现或宣称新视觉已确认。

## scan_scope / scan_output
- 仅上述明确源码与设计路径；未读取凭据。

## handoff
- 主题阴影回归的源码/类型/聚焦测试/真实组件与实际运行预览验证完成，当前包为 `20261004-theme-shadow-ee41bfa046c2`，刷新可见原有主题阴影/描边/flat 效果。新的局部过渡视觉仍待样例确认，不能宣称用户观感已验收。
- 主题阴影独立所有权和修正后的 SHL-05 已固化到正式设计；真实 iOS/macOS 原生材质仍未实测，不把 Chromium 移动模拟当作原生验收。
