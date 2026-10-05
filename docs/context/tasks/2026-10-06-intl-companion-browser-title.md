---
id: task-2026-10-06-intl-companion-browser-title
type: task
scope: 国际站首页与智能体入口浏览器标题统一及内嵌 OpenCraft 标题所有权修复。
triggers: ["browser title", "international homepage", "embedded OpenCraft"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/app/(site)/page.next.tsx
  - frontend/next-site/agent-document-metadata.ts
  - opencraft/apps/workbench-web/src/app.tsx
status: active
reviewed_at: 2026-10-06
review_due: 2026-11-06
revision: 1.0.0
precedence: task
derived: false
---

## goal
国际站英文首页和智能体页的浏览器标题统一为 `My AI Companion | LightVela`，并消除内嵌 OpenCraft 在离开聊天时留下 `OpenCraft` 标题。

## non_goals
- 不修改国内站或其他语言的页面标题。
- 不修改站点 URL、sitemap、发布配置或生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户请求（2026-10-06）：`要不就都统一显示：My AI Companion | LightVela`；对应截图中的国际站 `/` 和 `/agents/`。

## interface_refs / data_structure_refs
- Next Metadata：`frontend/src/app/(site)/page.next.tsx`、`frontend/next-site/agent-document-metadata.ts`。
- OpenCraft 嵌入标识：`opencraft/apps/workbench-web/src/app.tsx` 的 `embedded` 参数。
- 不变量：内嵌组件不拥有宿主文档标题；独立 OpenCraft 保留自身标题。

## history_context
- current_design_refs：`docs/engineering/domains/site-environment-routing.md`、`docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/platform-architecture.md`。
- relevant_evolution：当前 OpenCraft App 卸载清理把宿主 `document.title` 写为 `OpenCraft`；源码见上述 `app.tsx`。
- superseded_refs：无。

## acceptance
- 国际站英文 `/` 与 `/agents/` 的服务端标题一致，客户端路由标题一致。
- 从内嵌聊天离开后不出现 `OpenCraft` 残留标题。
- 国内站和其他语言的标题保持原有文案。

## affected_paths
- `frontend/src/app/`、`frontend/next-site/`、`frontend/src/lib/seo-data.ts`、相关测试。
- `opencraft/apps/workbench-web/src/app.tsx`、相关测试。
- `docs/engineering/domains/site-environment-routing.md`、`docs/engineering/domains/agent-gateway-runtime.md`。

## required_context
- `site-environment-routing`、`frontend-product-surface`、`agent-gateway-runtime`、`service-opencraft`、`upstream-subtrees`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@717a4d315` | 双站边界 | 保持国内站与多语标题 |
| `docs/context/project/services/frontend.md@717a4d315` | 前端验证入口 | 选择前端门禁 |
| `frontend/AGENTS.md@717a4d315` | 服务规则 | Next.js 与同步门禁 |
| `docs/context/domains/agent-gateway-runtime.md@717a4d315` | OpenCraft 所有权 | 区分嵌入与宿主 |
| `docs/context/project/upstream-subtrees.md@717a4d315` | OpenCraft 真源 | 在 mono2 内修改 |
| `docs/context/project/services/opencraft.md@717a4d315` | OpenCraft 验证入口 | 选择聚焦测试 |
| `opencraft/AGENTS.md@717a4d315` | 服务规则 | 保留独立应用标题 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@717a4d315` | 前端邻接 | 检查相邻标题测试 |
| `docs/engineering/domains/site-environment-routing.md@717a4d315` | 正式设计 | 记录国际站标题政策 |
| `docs/engineering/domains/agent-gateway-runtime.md@717a4d315` | OpenCraft 正式设计 | 记录嵌入标题所有权 |

## evidence
- 前端聚焦测试：4 文件、49 测试通过；OpenCraft 聚焦测试：4 测试通过；OpenCraft Web typecheck 通过。
- `pnpm check` 通过：166 current / 171 baseline / 0 new；现有 i18n 告警 47 条。
- `pnpm build:global` 通过，SEO 检查覆盖 42 条 public static routes；产物 `/`、`/agents/`、`/agents/chat/` 均为目标标题，`/zh-sg/` 保留中文标题。
- `pnpm build:cn` 通过，SEO 检查覆盖 8 条 public static routes；产物首页与 `/agents/` 均保留中文标题。
- `npm run build:embedded-workbench:release` 通过；`npm run check:mono2-agent-console` 验证 130 个文件无同步漂移。
- 本地国际站 `pnpm dev:global` 启动于 127.0.0.1:5174，Chrome 实际打开 `/` 与 `/agents/`，标签均为目标标题；未登录且本地认证服务不可用，未在真实嵌入聊天中复现导航。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 通过；documentation 检查通过，0 个断链。Context Catalog 全量校验因仓库既有大量活动 Task Pack 元数据缺失而失败，当前 Task Pack 修正后未见新错误。
- 完整 `pnpm test` 尝试中，本次未改模块已有多项失败，Vitest worker 发生 Node heap OOM；为避免持续资源消耗中止，exit 130，未宣称全量通过。

## risks
- 若线上内嵌脚本仍来自旧构建，生产标题不会随源码更改；以实际发布版本和浏览器复核。
- OpenCraft 独立 Web/Electron 仍需保持任务标题与 `OpenCraft` 回退标题。

## validation
- 前端聚焦测试、`pnpm check`、双站 build、完整 `pnpm test` 尝试；OpenCraft 聚焦测试、typecheck、嵌入构建；context change-impact 检查。

## decisions
- 仅统一截图涉及的国际站英文页面；其他页面保留描述性 SEO 标题。
- OpenCraft 的 `document.title` 写入限定为独立运行，内嵌时由 LightVela 宿主负责。

## scan_scope
- `frontend/src/app/`、`frontend/next-site/`、`frontend/src/lib/`、`opencraft/apps/workbench-web/src/`。

## scan_output
- 有界 `rg` 显示：首页标题、Agent 标题与 OpenCraft 卸载清理分别由上述文件拥有。

## handoff
- 源码与本地构建已验证；本轮提交 MR，远端提交及 MR 状态以工蜂实时记录为准。尚未发布；真实登录后的嵌入聊天跳转及线上效果需在后续发布版本复核。
