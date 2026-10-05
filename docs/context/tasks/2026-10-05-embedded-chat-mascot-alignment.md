## goal
国际站 Agents Chat 新对话空状态在窄屏时让 Logo 丝带与标题下方紫色细线对齐。

## non_goals
- 不改变聊天、Draft、Composer 的行为或其他页面插画。
- 不提交、推送或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 提供 `/agents/chat/` 窄屏和宽屏截图：窄屏 Logo 与左侧紫色细线错位，宽屏正常。

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/components/new-thread-draft-page.tsx` 的 `.new-thread-draft-hero h1`。
- `opencraft/apps/workbench-web/src/styles/app.scss` 的嵌入式标题 `::before` 细线与 `::after` 插画。

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/chat-ui-architecture.md`。
- relevant_evolution: 当前嵌入式空状态 CSS 由 commit `2155840c5d` 引入；细线以标题底部定位，插画固定 `top: -16px`。
- superseded_refs: 无。

## acceptance
- 标题字号因视口缩小时，插画丝带与细线同步移动；宽屏原有对齐基本不变。
- OpenCraft Web 构建、相关类型检查和聚焦测试通过；用浏览器窄/宽视口对照呈现。

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`、`site-environment-routing`、`upstream-subtrees`、`service-opencraft`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | OpenCraft 责任边界 | 限定为嵌入聊天呈现 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站边界 | 确认截图指向国际站嵌入 Chat |
| `docs/context/project/upstream-subtrees.md@2.3.0` | OpenCraft 真源 | 在 mono2 修改 |
| `docs/context/project/services/opencraft.md@1.0.0` | 服务验证 | 运行 OpenCraft 聚焦门禁 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端宿主 | 不把 Web 构建视为线上发布 |
| `opencraft/AGENTS.md` | 本地规则 | 核对视觉验证与设计文档 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 维护方法 | 按可见结果验证 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 视觉验收层次 | 使用浏览器窄/宽视口 |
| `opencraft/docs/chat-ui-architecture.md` | Chat 所有权 | 不触及 Draft/Composer 行为 |

## evidence
- 独立 Chromium 布局对照：1180px 视口下标题高度 29.94px，旧插画 `top=-16px`，新插画 `top=-24.06px`；1800px 下旧 `-16px`、新 `-16.25px`。细线锚点始终位于标题底部。
- 使用本次 `npm run build:web` 产出的实际 `main-*.css`，在 Chromium 800/1180/1800px 视口渲染空状态，窄屏丝带与细线相接；截图留在 `/tmp/lightvela-layout-check/built-*.png`，是隔离 DOM 验证而非已登录真实页面。
- `./node_modules/.bin/tsx --test tests/embedded-companion-locales.test.ts tests/embedded-workbench-presentation-root.test.ts`：2/2 通过。
- `npm run typecheck --workspace @opencraft/workbench-web`、`npm run build:web`、`git diff --check`、文档校验通过。
- `validate_change_impact.py --repo . --staged` 使用临时 Git index 检查本轮源码与正式设计文档，通过；主 index 未暂存。

## risks
- 插画仍使用已有位图；本次仅改变其垂直锚点。若标题换成多行，底边定位仍能保持与装饰线相随。

## validation
- OpenCraft Web TypeScript 检查、相关测试与 Web 构建；浏览器窄/宽视口对照；文档及 diff 检查。

## decisions
- 将插画的 `top` 表达为相对标题底边，而不是按某一字号固定偏移；宽屏原位置约保持不变。

## scan_scope
- 首次在 `frontend/src/pages/marketing` 搜索完整标题文案无命中，扩大到 `opencraft/apps/workbench-web` 精确命中。

## scan_output
- 标题在 `app.tsx` 传给 `NewThreadDraftPage`，最终由 `app.scss` 的两个伪元素绘制。

## handoff
- 本地源码与 Web 构建已验证，真实已登录 Agent 页面未复现；worktree 中保留先前任务的未提交改动，未覆盖、提交、推送或发布。
