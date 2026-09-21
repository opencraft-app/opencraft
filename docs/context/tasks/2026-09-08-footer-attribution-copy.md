## goal
统一 LightVela 产品页脚的版权与 Tencent Lighthouse 出品文案，确保 `/agents`、`/account` 及共用页脚的其他页面在全部已发布语言中使用同一简洁表达。

## non_goals
- 不调整首页独立静态页脚、链接、备案号、布局或样式。
- 不发布、合并或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-08）：中文使用“© 2026 LightVela · 腾讯轻量云出品”，英文使用“© 2026 LightVela · Built by Tencent Lighthouse”，其他语言采用同类表达，并同步 `/agents` 与 `/account`。

## interface_refs / data_structure_refs
- `frontend/src/components/site/legal-footer.tsx`：共用产品法律页脚。
- `frontend/src/components/site/product-chrome.tsx`：`/agents` 与 `/account` 的产品页壳及页脚入口。
- `frontend/src/i18n/generated/*.json`：由中文原文提取键并维护各语言译文。

## history_context
- `current_design_refs`：`docs/context/domains/site-environment-routing.md`、`frontend/AGENTS.md`。
- `relevant_evolution`：现有 `LegalFooter` 已统一承载国内站和国际站产品页脚，区域差异仅保留链接与备案展示。
- `superseded_refs`：旧文案包含 `Copyright`、`版权所有`、`All rights reserved` 和 `Powered by`，本次由用户明确替换。

## acceptance
- `/agents` 与 `/account` 的中文页脚显示 `© 2026 LightVela · 腾讯轻量云出品`。
- 英文显示 `© 2026 LightVela · Built by Tencent Lighthouse`。
- 繁中、西语、印尼语、日语、韩语均使用对应语言的简洁出品表达。
- i18n 生成检查、聚焦测试和前端门禁通过。

## affected_paths
- `frontend/src/components/site/legal-footer.tsx`
- `frontend/src/components/site/__tests__/legal-footer.test.tsx`
- `frontend/src/i18n/generated/*.json`
- `docs/context/tasks/2026-09-08-footer-attribution-copy.md`

## required_context
- `site-environment-routing`
- `frontend-service-detail`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 国内站与国际站是独立交付面 | 要求所有 locale 同步验证 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务验证边界 | 确定聚焦测试与类型门禁 |
| `frontend/AGENTS.md@working-tree` | 前端实现硬规则 | 保持最小改动并补回归测试 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | i18n 生成物邻接 | 使用提取和繁中生成入口维护字典 |

## evidence
- 精确搜索确认 `LegalFooter` 是文案唯一运行时来源；`ProductPageShell` 与 `ProductFooter` 将其分别用于 `/account` 和 `/agents`。
- `pnpm i18n:extract`：发现 2726 条中文文案，新键已进入所有字典。
- `pnpm i18n:zh-hant:check`：2726 条繁中转换结果一致。
- `pnpm vitest run --api.host=127.0.0.1 src/components/site/__tests__/legal-footer.test.tsx`：1 个文件、5 个测试通过。
- `pnpm check`：i18n、文档生成与 TypeScript 基线门禁通过，0 个新增 TypeScript 问题。
- 本地 5174 国内站预览：`/agents/` 与 `/account/` 的可访问性树及截图均显示 `© 2026 LightVela · 腾讯轻量云出品`。
- `validate_change_impact.py --staged` 与 `validate_documentation.py`：均通过，无缺失映射、断链或 owner review 要求。

## risks
- 新中文原文会生成新 hash key；若各语言未补译文会回退中文。通过全语言字典断言和 i18n 检查缓解。
- 共用组件会影响其他产品页面；文案意图是全局统一，且不改变结构与链接，回滚只需恢复该翻译键。

## validation
- `pnpm i18n:extract`
- `pnpm i18n:zh-hant`
- `pnpm i18n:zh-hant:check`
- 聚焦 `legal-footer` 测试
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 复用现有 `LegalFooter` 单一入口，不为两个页面增加分支文案。
- 保留动态年份插值和 ICP/链接逻辑，仅替换可见文案。

## scan_scope
- `frontend/src/components/site/`
- `frontend/src/pages/marketing/`
- `frontend/src/i18n/`
- `frontend/openspec/`

## scan_output
- 无独立扫描产物；精确搜索结果记录在本任务执行日志中。

## handoff
- 实现与本地验证完成；待用户确认后提交并推送至现有 MR !3717。
