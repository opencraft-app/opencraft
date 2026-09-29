---
id: opencraft-codex-url-presentation
type: task
scope: Codex-faithful external URL presentation and opening intents in OpenCraft chat.
triggers: ["Codex URL rendering", "external link presentation"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-codex-url-presentation.md
status: complete
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.0.1
precedence: task
derived: false
---

## goal
复刻 Codex 模型回复中 HTTP(S) URL 的资源化呈现：favicon/地球兜底、URL tooltip、流式安全 pending、修饰键打开意图以及 Radix 右键打开/复制操作，同时保持 Markdown 块级语义和 Browser owner 不变。

## non_goals
- 不重写 Markdown compiler，不根据 URL 改写 heading/list/table 结构。
- 不让 Renderer 创建或持久化 Browser Session；不绕过现有 URL policy。
- 不修改模型输出、提示词、远端内容或生产发布。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-codex-url-presentation`：用户要求梳理 URL 渲染所有权并复刻 Codex 行为，不接受页面级 hack。

## interface_refs / data_structure_refs
- `opencraft/packages/chat-render-react/src/contracts.ts`
- `opencraft/packages/chat-render-react/src/resource-target.ts`
- `opencraft/packages/chat-render-web/src/renderers/resource-link/*`
- `opencraft/apps/workbench-web/src/app.tsx`
- 不变量：compiler 拥有 Markdown 结构；resource policy 拥有安全分类；Web renderer 拥有 URL 视觉与 DOM 交互；Workbench Browser runtime 拥有真实打开动作。

## history_context
- `current_design_refs`：`opencraft/docs/chat-ui-architecture.md`、`opencraft/docs/browser-workbench-architecture.md`。
- `relevant_evolution`：OpenCraft 已有同步 URL 分类、tracking 参数清洗和内置 Browser 打开能力，但外链仍是裸 `<a>`。
- `superseded_refs`：无。

## acceptance
- HTTP(S) 链接展示 favicon，失败时稳定回退地球图标；正文 label 和 Markdown heading 层级保持不变。
- hover/focus tooltip 显示清洗后的 URL；流式 URL 在 500ms 稳定前不可点击且不加载远端 favicon。
- 普通点击、Command/Ctrl/中键和右键菜单产生显式 opening intent；复制使用清洗后的 URL。
- restricted/unsafe URL 不获得远端 favicon、href 或打开动作。
- Web/React/chat 聚焦测试、typecheck、boundary 和真实组件 smoke 通过。

## affected_paths
- `opencraft/packages/chat-render-react/`
- `opencraft/packages/chat-render-web/`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/tests/`、正式 Chat/Browser 设计和 lockfile。

## required_context
- 根 `AGENTS.md`
- `opencraft/AGENTS.md`
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`
- `opencraft/docs/chat-ui-architecture.md`
- `opencraft/docs/browser-workbench-architecture.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库、Task Pack 与验证边界 | 不发布、不覆盖用户工作树 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft Renderer/Shell 所有权 | 禁止业务页私有 URL 行为 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 维护与实机验收方法 | 共享语义、平台适配 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Chat/跨包验证入口 | 选择聚焦测试与真实组件 |
| `.agents/skills/baseline-ui/SKILL.md@working-tree` | 可访问控件与 token 约束 | 使用 Radix、焦点与既有主题 |
| `.agents/skills/better-icons/SKILL.md@working-tree` | 图标来源约束 | 采用已核对的 Lucide globe/copy/external-link |
| `ref/codex/conversations/create-conversation-link-renderer-07885.ts@66a586468` | Codex 会话链接路由 | 文件引用优先，外链进入模型回复链接组件 |
| `ref/codex/shared/render-mention-avatar-image-07879.ts@66a586468` | Codex URL 呈现 | favicon/地球兜底、inline mention、tooltip |
| `ref/codex/features/shared/handle-pull-request-link-click.ts@66a586468` | Codex 打开行为 | 修饰键、Browser target 与统一 dispatch |

## evidence
- `node --import tsx --test tests/chat-url-presentation.test.ts`：2/2 通过，覆盖 favicon fallback、指针/键盘/菜单 opening intent 和 500ms settle 常量。
- `OPENCRAFT_PLAYWRIGHT_MODULE=... OPENCRAFT_CHROMIUM_EXECUTABLE=... npm run smoke:url-presentation`：真实 Chromium 通过，`headingPreserved=true`、`faviconFallback=true`、`streamingSafetyMs=500`；截图为 `/tmp/opencraft-url-presentation.png`。
- `npm run test:chat`：415/415 通过；`npm run test:i18n`：10/10 通过；`npm run check:i18n` 通过。
- `npm run typecheck`、`npm run check:boundaries`、`npm run build:web`、`npm run build:electron` 通过；最后增量复验 `@opencraft/chat-render-web` 与 `@opencraft/workbench-web` typecheck 通过。
- `python3 .agents/context/scripts/validate_change_impact.py` 对本 Task 精确文件集通过；该规则仍要求 `wisp/mono2-maintainers` owner review。
- `git diff --check` 通过。
- `validate_documentation.py` 仍被本任务外既有断链阻塞：`docs/runbooks/nextgen-dashboard-argocd-cutover.md` 引用不存在的 `../../scripts/ssm_manifest.nextgen-dashboard.beijing-sandbox.yaml`；未在本任务扩大范围修复。

## risks
- favicon 请求会向目标 origin/Google 暴露域名；仅对 policy 允许且稳定的 HTTP(S) URL加载，restricted 模式完全禁止。
- Portal 菜单必须继承主题层级且不改变 Markdown 测量几何。
- 流式延迟结果须由当前 href owner 取消，旧 URL 不得迟到激活。

## validation
- Chat document/runtime/component 聚焦测试。
- `npm run test:chat`、受影响 workspace typecheck、`npm run check:boundaries`。
- Web/Electron build 与隔离真实组件截图；不访问真实敏感 URL。
- documentation/change-impact。

## decisions
- URL 视觉属于 `chat-render-web`，不进入 renderer-neutral document model。
- 打开目标是 `ChatResourceOpenIntent`，Browser 创建继续由 Workbench owner 执行。
- 复用 Radix ContextMenu/Tooltip 与主题 token；不手写菜单焦点或数值层级。

## scan_scope
- `opencraft/packages/chat-render-{react,web}`
- `opencraft/apps/workbench-web/src/app.tsx`
- `ref/codex` 对应 URL renderer。

## scan_output
- 本 Task Pack 的 context/evidence 段。

## handoff
- 已完成源码、测试与正式设计文档整改；未提交、推送、替换 `/Applications/OpenCraft.app` 或发布生产。
- 产品级打开动作由 `ChatResourceOpenIntent` 表达，Renderer 不持有 Browser Session；Workbench 将默认/内置/外部与前台/后台意图投影到现有 Browser owner。
- URL 的大字号仍由原始 Markdown heading 决定；链接组件只增加 favicon、tooltip、菜单与安全交互，不扁平化模型内容语义。
