# Titlebar upper lip follows live motion

## goal
修复窄栏标题栏延迟突变；按用户“上半部分继续左移而来”，让白色主表面上沿随同一段位移动画向左延伸，增加柔和横向细线。

## non_goals
- 不加渐变、不以独立 fade/CSS timer 掩盖时序；不改按钮/标题位置、窗口按钮预留、布局宽度、业务内容生命周期。
- 不改变 expanded/context/浮动材质、主题阴影/描边；仅在用户明确授权后替换预览，不重启后台。

## requirement_refs / requirement_excerpt
用户：“有一秒的延迟才显示，像是补丁一样，另外缺乏过渡，比如横线”；补充：“我希望动画更像是原来的白色，上半部分继续左移而来”。
后续确认实际当前预览仍是旧绘制模型，用户明确授权：“加上去”。

## interface_refs / data_structure_refs
- `animatedNavigationWidth`、`animatedSidebarWidth`、`sidebarProgress` 是现有帧/显隐权威；`titlebarSurfaceGeometry` 是纯绘制投影。
- Header 只绘制主表面向左延伸的上沿与横线，不挪动 controls/fit slot，不覆盖 main 原有 edge-scroll 表面政策；Sidecar 竖分界共用绘制进度。
- pane mounted/unmount 保持原内容生命周期；不再用 `sidecarCompactOnly` 的终点 boolean 当绘制时钟。

## history_context
- current_design_refs: workbench-design-language / platform-architecture / SHL-05。
- relevant_evolution: compact-titlebar 的最终截图/主题正确，但 root boolean 等 context 退场完成才切换 Header 背景，因此中间帧会像补丁突然出现。
- superseded_refs: 2026-10-04-opencraft-compact-titlebar 的“退出释放后才允许换色”是错误绘制约束；退出 owner 只应决定内容生命周期。旧 smoke 错误肯定了等待终点的行为。

## acceptance
- 退出前 100ms、中间帧已开始向左延伸，仍 mounted 的 context 不妨碍绘制；上沿延伸的右端与同一实时 Sidecar/main 边界相接。
- 最终顶部连续、下方横竖细线；普通调宽/expanded/context 不增加上沿；隐藏全部时残留宽度/分界进度为零。
- 快速反向、reduced motion、held resize、safe-area、草稿 DOM、10 种主题/模式与浮层回归。

## affected_paths
- opencraft/apps/workbench-web/src/components/titlebar-surface-geometry.ts
- opencraft/apps/workbench-web/src/components/app-shell.tsx
- opencraft/apps/workbench-web/src/components/sidecar.tsx
- opencraft/apps/workbench-web/src/components/shell-navigation/shell-navigation.scss
- opencraft/apps/workbench-web/src/styles/app.scss
- opencraft/tests/titlebar-surface-geometry.test.ts
- opencraft/tests/shared-control-standards.test.ts
- opencraft/scripts/smoke-shell-material-edge.ts
- opencraft/package.json
- opencraft/docs/workbench-design-language.md
- opencraft/docs/platform-architecture.md
- opencraft/design/invariants.md
- docs/engineering/domains/agent-gateway-runtime.md

## context_receipt
- 根/OpenCraft AGENTS 与 maintenance Skill/verification 已完整读取；Router 本轮 `opencraft compact titlebar delayed painting context exit horizontal divider` 无匹配。
- bounded exact 读取 app-shell / use-panel-animation / primary-motion / Sidecar / Header 样式、原 smoke 与实际 buildId；读取邻接卡并复核共享控件测试；正式设计同步纠正错误时序。
- actual preview 保持 `20261004-compact-titlebar-df515a3c692b`，没有 live 写入/Host 调用/凭据读取。
- 替换轮次重新读取根/OpenCraft AGENTS、maintenance/verification、自托管预览 Skill 与邻接卡/共享控件测试；Router `opencraft self hosted preview titlebar live motion static replacement` 无匹配，限定读取先前切换脚本与当前包。实际运行基线已被其他更新推进到 `20261004-navigation-icons-80433d8b205c`，不使用旧包覆盖。

## decisions
- compact 程度从当前 primary frame 在共享 compact/expandedMinimum 档位间投影；context 关闭程度消费现有 progress，不依赖语义提交或卸载。
- extensionWidth = primaryWidth × compactProgress × (1 - contextProgress)，left = contextWidth + primaryWidth - extensionWidth。这只定义当前白色上沿绘制矩形，不改变三栏几何。
- Header before/after 与 Sidecar divider 只读共享 MotionValue，没有额外动画写入者/延迟；正文主题 elevation 保留。

## risks
旧测试预期会为延迟背书，必须新增初始/中间帧与反向证据；Header stacking context、theme 像素、强制颜色、端点连续性需真实浏览器核对。

## validation / evidence
- 几何/共享控件 9/9，`test:shell-space` 21/21，相关 window-chrome/theme-material/appearance/控件 30/30；Web 类型检查、边界、字体门禁通过。
- 隔离源码构建 `/tmp/opencraft-titlebar-live-motion-build-6DTkDx` 通过；沿用原有 bundle/dynamic-import 警告，未作为线上替换包。
- 真实组件浏览器证据 `/tmp/opencraft-shell-material-edge-dKW4dg/report.json`：10 个 context 主题/模式与 20 个 compact 浏览器/模拟 Electron safe-area 用例通过，无 pageerror；Frost 浅色截图已人工核对连续白顶、细横线、原主题阴影。
- context 退出 30 帧证明前 100ms 已开始延伸，约 374ms 上沿完成时 pane 仍 mounted，约 393ms 才释放；每帧延伸右端与实时 Sidecar 边界相接。快速反向从中间宽度续接，无端点跳变。
- reduced-motion 必须在新 renderer 挂载前声明媒体偏好；在现有 Motion 渲染调度传播后由 0 直接到 52，无插值帧。不能用仅两次 rAF 的旧测试断言误判产品。
- held resize、边缘命中、强制颜色、隐藏零宽、手机浮层主题阴影、主草稿 DOM 身份保留通过。Electron 是浏览器模拟 safe-area；未进行真实 macOS 原生窗口/手机实机验收。

## scan_scope / scan_output
以上 Shell/测试/设计路径；未扩大到参考仓库或生产日志。

## handoff
源码实现与验证完成；用户授权后已将实际 navigation-icons 基线前端更新为 `20261004-titlebar-motion-5055df91da53`。后台未重启，PID 2785955、unit `opencraft-neutral-focus-20261004-preview.service`、runtime SHA256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a` 与切换前一致，数据目录未改变。用户页面刷新后加载新资源；设备观感仍待用户验收。

## preview_delivery_evidence
- `prepare.mjs` 从实际包生成新 immutable namespace，geometry helper 从当前真源转译并消费实际共享 metrics；只替换已明确的 Header/Sidecar 绘制与运动投影，逆操作证明其他 JS/CSS 字节完整保留，包括 navigation-icons/default-steer；历史资源逐文件哈希保持。
- `/data/opencraft-titlebar-motion-preview-6SmdvN/provenance.json` 记录来源和源文件摘要；`candidate-evidence.json` 与 `live-evidence.json` 均 30 个主题/平台用例通过，实际包动画首个宽度大于 1px 的帧约 25.5ms，context 仍 mounted；快速反向、reduced snap、held resize、草稿 DOM、强制颜色和手机浮层检查通过，无页面/资源错误，无真实 Host 写入。
- 独立 `opencraft-titlebar-motion-web-swap-20261004.service` 原子交换 Web 目录，失败自动回退；`status.json` success=true / backendRestarted=false / liveBrowserVerified=true，unit ExecMainStatus=0。
- 实际 `/version.json`、健康接口、JS/CSS HTTP 200/hash/immutable 缓存验证通过；新资源有 extension-width，无旧 compact-only 终点切换。浅色 Frost 实际包截图已核对。旧 Web 留在 stage `/web` 可回退。
- 本轮重新跑几何/共享控件 9/9、Web 类型检查、boundaries/typography 与 docs-impact，均通过。第一次 reduced-mode 包验收复用先前移动端操作的偏好 scope，读取已隐藏的 dock 导致测试错误；改为独立新浏览器 context（未改产品/候选包），候选及 live 验收通过。

## checkpoint
- done: 将终点换色改为已有实时几何的白色上沿延伸；横/竖细线共用同一投影；相关正式设计与验证契约同步纠正。
- pending: 无实施/切换步骤遗留；当前设备观感仍待用户验证，不把模拟 Electron safe-area 称为 macOS 实机。
- resume: 当前 build `20261004-titlebar-motion-5055df91da53`；下次先核对真实运行版本/摘要。回退点在 `/data/opencraft-titlebar-motion-preview-6SmdvN/web`，runtime/data 不变；不需要重启 Host 或后台。
