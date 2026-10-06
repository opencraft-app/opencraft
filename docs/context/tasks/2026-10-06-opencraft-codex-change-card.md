# Codex 文件变更资源卡对齐

## goal
按本机 Codex 26.930.31428/build 12913 的原始 Renderer 对齐 Web 文件变更资源卡的视觉和查看交互。

## non_goals
- 不混入听写/模型迁移等并行未提交改动，不修改 GitOps 或生产部署。
- 不制造没有 Host apply-patch 支持的撤销操作，不重建 Review 工作区或 Native 渲染器。

## requirement_refs / requirement_excerpt
- 2026-10-06 用户：文件变更卡片严格复刻 Codex。
- 2026-10-06 用户后续授权：提交、推送、合入 master，并合入当前预览。

## interface_refs / data_structure_refs
- chat-core `TimelineFrame.changeSummary` / `AssistantTurnPresentationPlan.changeSummary` 是 Turn 附属资源，不进入消息 slots，不改变工作完成、折叠或 follow owner。
- Web document context 的 onReviewTurnDiff 拥有查看意图，组件只拥有展开和悬浮状态。

## history_context
- 当前设计：`opencraft/docs/chat-ui-architecture.md` 的 Changed-file review。
- 前一任务已修复假 turnDiff Item 导致活跃工作折叠，必须保留；本轮只改资源呈现。
- 最新参考原始 `sites-end-resource-b8a510733e15.js` 的 xE/SE/wE、`app-initial-970035cbb6b0.js` 的 resource card/diff stats，以及 diff-preview-tooltip；不把 Wakaru 分析当作运行入口。

## acceptance
- 运行中：轻量文字入口随实际 Composer 位于输入框上方、两项小号数字、可交互的文件悬浮列表；主/mini transcript 不重复呈现。
- 完成：方形加减图标、约64px头部（按字号自适应）、12px横向内距、10px间距、主题radius-lg（默认10px）、查看更改；多文件默认前三行、36px行、展开/折叠。
- basename 优先，数字不被长路径挤掉；零值计数保留；计数更新使用数字滚动并尊重减少动态效果。
- 小文件悬浮预览，大文件不进入内联渲染；普通点击查看更改、修饰键点击打开文件。
- 使用既有 Button、Radix Tooltip、主题/焦点体系；中文文案、窄屏/桌面、亮暗主题与资源生命周期回归。

## affected_paths
- Web conversation 的 turn-diff 资源组件、document context、App/Composer 呈现身份、Codex 图标、样式、中文目录及浏览器 fixture/test。
- Review diff 单次索引与对应单测；Web workspace 显式声明已有 Radix Tooltip 依赖及 lockfile。
- 正式 Chat 文档、agent-gateway-runtime Domain、本 Task Pack/checkpoint。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根及 OpenCraft AGENTS.md | 范围和门禁 | 不隐含交付授权，保护脏工作区 |
| opencraft-maintenance SKILL.md / references/verification.md | UI、所有权和验证 | 使用成熟基础控件，分层说明验收 |
| design/README.md、docs/chat-ui-architecture.md Changed-file review | 正式设计 | 资源和消息/工作记录分离 |
| frontend-runtime-openspec-i18n adjacency | UI 与邻居 | 检查实际 changed-file layout browser test / Intl fixture |
| 新 Codex ANALYSIS-ZH.md、原始 Renderer/样式 | 版本与布局证据 | 精确指标、计数零值、文件列表和悬浮行为 |

## evidence
- Router 查询 `OpenCraft strictly replicate Codex changed files end resource card review visual` 无匹配，随后只搜索 Web conversation/样式及 diff 邻居测试。
- 旧实现头部 56px/p8/gap12/r12、文件代码图标、Review 标签、隐藏零计数、无悬浮列表/预览，均与新参考不同。
- Codex stats 为 chat字号减1，gap4，正负项都显示；头部 p12/icon40/gap10，卡片 rounded-lg。已核对真实 CSS token 而非 Tailwind 默认值，radius-lg 为10px；预览延迟800ms，最多420px高，5000行以上无内联预览。
- 当前 80 端口仍为 PID 534254 的 20261006-hunyuan-desktop-634fcdab5 预览，不包含本次源码改动。

## decisions
- 按真实能力保留现有 read-only Review，不冒充 Codex apply-patch/Changes workspace。
- View 只消费稳定的资源，悬浮不执行读取 Host/推理，不获得业务写权。

## risks / validation
- 本机无法运行 macOS Codex 原产品；参考为固定版本原始源码，验收为本项目真实 Chromium 组件，不宣称 Safari/真机像素验收。
- Web 类型、字体/平台边界、生产构建通过；487 项 chat 回归通过，资源/Review 聚焦单测 11 例通过。
- 卡片浏览器矩阵 12 组通过（320/390/1000px，亮/暗，中/英）：真实几何、溢出、零计数、展开、小/大 diff、鼠标/键盘选择、修饰键打开及减少动态效果。
- Conversation + Composer + Review 资源生命周期 4 组通过；既有 diff 布局 8 组通过。
- 最终截图 `/tmp/opencraft-codex-change-card-5XmInz`，已人工检查 390px 中文亮色与 1000px 英文暗色悬浮预览。截图中顶部两个按钮仅为测试驱动，不进入产品。
- 文档链接/变更影响校验及 diff whitespace 检查通过；尚未执行正式提交门禁，当前也无提交授权。

## handoff
Web 源码和原工作树验证完成；当前预览未替换。按后续授权在隔离分支基于最新 master 集成，并执行独立候选验证、提交与切换；旧工作树并行改动保留。
