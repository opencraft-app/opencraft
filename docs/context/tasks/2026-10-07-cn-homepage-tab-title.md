## goal
将国内站首页浏览器标题统一为智能体入口使用的“我的智能体伙伴 | LightVela”。

## non_goals
- 不更改页面正文、国际站和其他语言标题，不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 截图：红框首页标签标题参考蓝框智能体标签标题，保持统一。

## interface_refs / data_structure_refs
- `frontend/src/app/(site)/page.next.tsx` 的 Next 首页 metadata；`frontend/src/lib/seo-data.ts` 的国内站首页 SEO 标题。首页标题不附加 root 模板后缀。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: 智能体入口已显示“我的智能体伙伴 | LightVela”，首页仍显示旧标题。
- superseded_refs: 无。

## acceptance
- 国内站首页 `<title>`、`og:title`、`twitter:title` 均为“我的智能体伙伴 | LightVela”；客户端 SEO 数据相同。
- 国际站首页仍为“My AI Companion | LightVela”。

## affected_paths
- `frontend/src/app/(site)/page.next.tsx`
- `frontend/src/lib/seo-data.ts`
- `frontend/src/lib/__tests__/seo.test.ts`
- `frontend/next-site/seo.test.ts`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- frontend-product-surface、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@20ee7b3d9` | 服务约束 | 确定前端验证范围 |
| `docs/context/domains/site-environment-routing.md@20ee7b3d9` | 双站边界 | 限定国内站首页 |
| `frontend/AGENTS.md@20ee7b3d9` | 服务规则 | 执行门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@20ee7b3d9` | 邻接 | 查看静态与客户端 SEO 邻居 |

## evidence
- 用户截图中蓝框 `/agents` 为“我的智能体伙伴 | LightVela”，红框首页仍显示旧标题。
- `frontend/next-site/agent-document-metadata.ts` 与 `app-route-shell.test.tsx` 确认中文智能体入口标题。
- 聚焦 SEO/页面标题测试 3 文件 62/62 通过；`pnpm check` 通过，0 新增 TypeScript 诊断。
- `pnpm build:cn`、`pnpm build:global` 通过。国内站生成的首页 `<title>`、`og:title`、`twitter:title` 均为“我的智能体伙伴 | LightVela”，`/agents` 标题相同；国际站首页与 `/agents` 均保持“My AI Companion | LightVela”。
- OpenCraft 同步只读检查与 `validate_documentation.py` 通过。
- `validate_change_impact.py --staged` 与 `git diff --check` 通过。
- MR !5052 CR 后增加首页 Next metadata 与客户端 SEO 标题的同值断言，聚焦测试 1/1 通过。

## risks
- 首页 metadata 和客户端 SEO 数据若分离，会在页面切换后显示不一致；两处同步调整。

## validation
- 聚焦 SEO 测试、`pnpm check`、国内及国际站构建，检查生成 HTML 标题。
- `npm --prefix opencraft run check:mono2-agent-console`、文档与 change-impact 门禁。

## decisions
- 只改国内站裸首页标题；国际站和其他语言沿用现有标题。

## scan_scope
- 首页 metadata、智能体 metadata、SEO 标题数据及相邻测试。

## scan_output
- 精确搜索定位首页 Next metadata 与 `DEFAULT_SEO_TITLE_BY_REGION.cn`。

## handoff
- 标题改动及双站构建核对完成；交由 MR 评审，未合并、未发布。
