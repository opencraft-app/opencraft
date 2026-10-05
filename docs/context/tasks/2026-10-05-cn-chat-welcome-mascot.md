## goal

在国内站新版对话的新建草稿欢迎区，以“文案左上、形象右下”的首页式组合展示官网 LightVela 小形象，并让文案下方的细线与形象飘带衔接。

## non_goals

- 不改变国际站 AgentChat、已有对话、发送逻辑或首页素材。
- 不提交、推送、发布或改动生产环境。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户 2026-10-05 截图：国内站“今天想一起做点什么？”欢迎区增加首页白紫色小形象，参考国际站空白对话页的图片位置。
- 用户后续修正：像首页一样，把那行文案放在形象左上方。
- 用户再次修正：参考首页文案下方的线，让细线与形象图片无缝接上。
- 用户视觉反馈：细线过长，左端只需延伸到文案末尾的“什么”附近。
- 用户最新反馈：缩小“今天想一起做点什么？”与右侧产品形象的水平距离。

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-web/src/app.tsx`：`embedded` 分支给 `NewThreadDraftPage` 传入国内站欢迎文案。
- `opencraft/apps/workbench-web/src/styles/app.scss`：草稿欢迎区与内嵌工作台根节点的呈现。
- `frontend/public/lightvela-intl-home/assets/lv-cover-lavender.webp`：官网首页现有透明素材。

## history_context

- current_design_refs：`opencraft/docs/chat-ui-architecture.md`、`docs/context/domains/site-environment-routing.md`。
- relevant_evolution：国内站聊天切到 OpenCraft 内嵌面板，国际站继续 AgentChat；以当前源码核对。

## acceptance

- 国内站新对话欢迎语位于小形象左上方，短细线从末尾“什么”附近延伸并接上形象左侧飘带；已有对话及独立 OpenCraft 页面不显示。
- 窄窗口不遮挡欢迎语或输入框。
- OpenCraft 聚焦验证、类型检查、构建，以及真实组件截图通过。

## affected_paths

- `opencraft/apps/workbench-web/src/styles/app.scss`

## required_context

- `site-environment-routing`、`service-opencraft`、`agent-gateway-runtime`、`upstream-subtrees`、`frontend-product-surface`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@current` | 双站边界 | 限定国内站呈现 |
| `docs/context/project/services/opencraft.md@current` | 服务入口 | 确定 OpenCraft 验证边界 |
| `docs/context/domains/agent-gateway-runtime.md@current` | Agent 运行时 | 避免误改运行时 |
| `docs/context/project/upstream-subtrees.md@current` | 源码归属 | 只改 mono2 真源 |
| `docs/context/project/services/frontend.md@current` | 前端素材与验证 | 复用官网素材 |
| `frontend/AGENTS.md@current` | 前端服务规则 | 视觉验证要求 |
| `opencraft/AGENTS.md@current` | OpenCraft 服务规则 | 维护与交接要求 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@current` | 前端邻接 | 核对实现及测试邻居 |
| `opencraft/docs/chat-ui-architecture.md@current` | 聊天 UI 设计 | 保持草稿与会话边界 |
| `opencraft/MONO2_MIGRATION.md@current` | 服务同步边界 | 避免修改生成层 |

## evidence

- 官网中文首页使用 `/lightvela-intl-home/assets/lv-cover-lavender.webp`；图片与截图一致。
- `chat.companionHeading` 仅在 OpenCraft 内嵌草稿分支传入。
- `npm run typecheck --workspace @opencraft/workbench-web` 通过。
- `npx tsx --test tests/embedded-workbench-presentation-root.test.ts tests/embedded-companion-locales.test.ts`：2/2 通过。
- `npm run build:web` 与 `npm run build:embedded-workbench:release` 通过；构建提示官网静态图片 URL 在运行时解析。
- 合成 Agent 的真实 `NewThreadDraftPage` 组件截图：修正后桌面、390×844 和 390×540 视口下文案在形象左上，图片、标题及 Composer 无重叠；本地静态图片请求为 HTTP 200 `image/webp`。新版截图：`cn-chat-welcome-mascot-text-left-preview.png`（本任务 visualizations 目录）。
- 2026-10-05 已获取并切到 `origin/master` 的 `e08b0db87`，保留本轮未提交样式；上游变更未触及该样式文件，没有冲突。以 `pnpm dev:cn` 在 5174 启动国内站；`/agents/chat/`、本地 OpenCraft 嵌入脚本及官网图片均返回 HTTP 200。Chrome 登录会话中 Agent 已暂停，真实草稿态暂不可达。
- 首页 `frontend/public/lightvela-intl-home/assets/hermes-home.css` 将独立细线与图片飘带分别渐隐后叠接；本轮在国内站草稿标题两个伪元素中沿用此处理。5174 上的临时视觉页检查了桌面、390×844 和 390×540：线与飘带相接，未遮挡输入框；视觉页仅是 CSS 示意，真实草稿组件的旧布局截图不包含新线。
- 按用户反馈把细线左端收至标题末尾约三个字宽，仅覆盖“什么？”附近到形象飘带；本地视觉页在桌面及 390×844 下检查了缩短后的衔接。
- 320px 宽度下标题换行时，形象位置需随标题底部移动；已改为按标题高度定位图片，并在 320×640、320×540 及 390×844 视觉页检查线与飘带衔接且不遮挡输入框。
- 缩小标题右侧预留宽度，桌面图片向文字靠近约 24px，窄屏约 14px；5174 视觉页在桌面、390×844、320×540 下检查文字、细线与形象衔接，没有遮挡输入框。
- 最新修改后 `@opencraft/workbench-web` 类型检查、2 项聚焦测试、`build:embedded-workbench:release` 均通过；5174 的内嵌脚本、预览页与图片 HTTP 200，构建脚本已包含新的 `86px` 预留与 `34px` 图片偏移。
- 暂存两份本轮文件后运行 `validate_change_impact.py --repo . --staged`：passed；随后撤销暂存。

## risks

- 内嵌 CSS 使用同站官网静态素材路径；构建与本地真实渲染须确认资源可达。
- 极矮容器空间不足；通过容器查询缩小小形象并检查布局。

## validation

- 运行 OpenCraft 相关测试、类型检查、Web 构建，并检查内嵌欢迎区截图。
- 交接前运行 `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions

- 仅给 OpenCraft 内嵌根节点的草稿欢迎语加装饰性伪元素，按用户修正把形象锚定在文案右下，不变更 React 状态或跨服务接口。
- 复用首页细线颜色 `#67509a` 和交接处的渐隐方式；细线放在 `::before`，图片保留在 `::after`。
- 复用官网现有素材，不制作或复制第二份图片。

## scan_scope

- `frontend/public/lightvela-intl-home/`、`opencraft/apps/workbench-web/src/`、相邻测试。

## scan_output

- 见本轮有界 `rg` 命中摘要；无独立扫描产物。

## handoff

- 源码已修改并通过本地验证，尚未提交、推送或发布。
- 已在真实国内站登录会话打开 5174 页面，但当前 Agent 已暂停，尚未验证真实草稿态或生产页面；合成 Agent 的真实组件截图用于欢迎态视觉验收。
- 最新间距可在 `http://localhost:5174/__opencraft/preview.html` 预览；该页为本地 CSS 示意，真实内嵌脚本已重建。
