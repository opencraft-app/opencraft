## goal
统一 LightVela 文档与站点元信息中的产品定位为“云端 AI Agent 产品”。

## non_goals
- 不改变 Agent 的云端托管能力说明、产品功能或发布状态。
- 不修改博客历史文章或其他与本次定位句无关的内容。

## requirement_ids / requirement_refs / requirement_excerpt
- 本次会话用户要求：将“云端 Agent 托管产品”改为“云端 AI Agent 产品”，并继续修改其他相同描述；后续明确 Tencent Lighthouse 和 Tencent Cloud Lighthouse 两种英文名称都可以。

## interface_refs / data_structure_refs
- `frontend/src/content/docs/` 是文档源；`frontend/scripts/sync-fumadocs-content.mjs` 生成渲染内容。
- `frontend/src/app/`、`frontend/src/lib/seo-data.ts`、`frontend/next-site/seo.tsx` 承载站点元信息。

## history_context
- `current_design_refs`: `docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`: 本次会话已将国内站 overview 摘要、正文与文档 description 改为新定位；相关文件还有未提交的其他修改。
- `superseded_refs`: 无。

## acceptance
- 目标文档与站点元信息不再出现旧产品定位；对应语言版本的定位语一致。
- 各语言概览将 Hermes Agent 描述为当前 AI 助理的运行基础，不再称为 LightVela 的产品。
- 云端托管能力说明保留；已有 Tencent Lighthouse 和 Tencent Cloud Lighthouse 名称均保留。
- 文档同步与最小有效检查通过。

## affected_paths
- `frontend/src/content/docs/`
- `frontend/src/app/`
- `frontend/src/lib/seo-data.ts`
- `frontend/next-site/seo.tsx`
- `frontend/scripts/sync-fumadocs-content.mjs`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `frontend-product-surface`: `docs/context/project/services/frontend.md`，`frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 前端双站与文档源边界 | 仅编辑源文件并同步生成物 |
| `frontend/AGENTS.md` | 前端门禁 | 运行最小有效验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 页面与语言邻接 | 核查 locale 与生成入口 |
| `docs/engineering/domains/site-environment-routing.md` | 双站正式设计 | 同步区域文案约定 |

## evidence
- `rg -n -F '云端 Agent 托管产品' frontend/src frontend/next-site frontend/scripts` 已定位剩余源文案。
- `pnpm docs:sync` 成功：同步 521 篇文档；8 个 locale 的 overview 与 who-is-lightvela-for 产物均含对应新定位。
- `pnpm check` 通过：文档同步、MDX 生成、i18n 检查和类型检查完成，0 个新增 TypeScript diagnostics。
- 聚焦 Vitest 在测试进程内临时映射 `localhost` 至 `127.0.0.1` 后通过：6 个测试文件、108 项断言；同时更新日语定位语的旧断言。
- `pnpm build:cn`、`pnpm build:global` 与 OpenCraft Agent Console 只读同步检查通过。
- `git diff --check` 与文档验证通过（0 断链、0 警告）；`validate_change_impact.py --repo . --staged` 对本次暂存变更通过。

## risks
- 本次在最新 `origin/master` 创建独立工作树，仅纳入本会话改动。
- 生成文档只通过同步脚本更新，不直接编辑。

## validation
- `pnpm docs:sync`、定点源/产物核对、`pnpm typecheck`、相关测试及 `git diff --check`。

## decisions
- 替换产品定义句并纠正各语言概览中的 Hermes Agent 产品称谓；描述部署和运行的“托管”事实保持原意。按用户后续澄清，撤回英文名称标准化改动。

## scan_scope
- `frontend/src/content/docs/`、`frontend/src/app/`、`frontend/src/lib/seo-data.ts`、`frontend/next-site/seo.tsx`、`frontend/scripts/`。

## scan_output
- 本 Task Pack 的 evidence 与最终交接摘要。

## handoff
- 文案修改与检查完成，准备提交 MR；未发布。
