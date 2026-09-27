---
id: cn-docs-public-beta-cleanup-2026-09-27
type: task
scope: 国内站中文文档中的过时产品公测说明清理。
triggers: ["cn docs", "公测说明", "国内站文档"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/content/docs/
  - frontend/src/app/llms.txt/route.next.ts
status: active
reviewed_at: 2026-09-27
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

## goal
移除国内站中文文档中过时的产品级公测说明，并使国内站 AI 检索摘要口径一致。

## non_goals
- 不修改国际站文档、路由和文案。
- 不删除仍由当前产品界面标为 Beta 的单项功能提示。
- 不合并 MR 或发布生产站。

## requirement_ids / requirement_refs / requirement_excerpt
- CN-DOCS-PUBLIC-BETA：用户截图指出概览页“公测阶段说明”，要求检查其他文档中的类似说法并删除。
- 后续工作接入现有国内站文档第一批 MR；国际站留待下一阶段。

## interface_refs / data_structure_refs
- `frontend/src/content/docs/` 是文档源；`frontend/src/content/docs/last-updated.json` 记录内容日期。
- `frontend/src/app/llms.txt/route.next.ts` 按 `cn`/`global` 分支输出事实摘要。
- `announcements/public-beta` 保留现有 URL 和侧栏注册，避免旧链接失效。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md` 产品文档区域。
- relevant_evolution: 现有概览与公告保留 2026 年 8 月公测阶段的说明；当前产品已有正式订阅入口。
- superseded_refs: 公测转入日期与此前注册用户延长权益，仅作历史事实，不再作为当前操作指南。

## acceptance
- 国内站中文概览、适用人群、付费公告及 `llms.txt` 不再把整站描述为公测中。
- 公告原 URL 有效，套餐与首购优惠指向订阅页；文档日期更新。
- 文档同步、聚焦测试、前端检查与 context 门禁通过，MR 远端状态已核对。

## affected_paths
- `frontend/src/content/docs/01-overview.md`、`who-is-lightvela-for.md`、`announcements/public-beta.md`、`last-updated.json`。
- `frontend/src/app/llms.txt/route.next.ts`、`docs/engineering/domains/site-environment-routing.md`。

## required_context
- 路由 `frontend-product-surface`；`frontend/AGENTS.md`；`docs/context/project/services/frontend.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|
| `docs/context/project/services/frontend.md@HEAD` | 路由 must_read | 前端服务边界 |
| `frontend/AGENTS.md@HEAD` | 服务级规则 | 文档同步与验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 前端邻接卡 | 检查文档与测试邻居 |
| `docs/engineering/domains/site-environment-routing.md@HEAD` | 设计真源 | 国内/国际区域边界 |
| `frontend/src/content/docs/__tests__/channel-consistency.test.ts@HEAD` | 相邻测试 | `llms.txt` 与文档事实检查 |

## evidence
- 源文档有界扫描发现 3 篇产品级公测表述；DeepSeek Harness 和工作台的 Beta 提示与界面标记一致。
- `pnpm docs:sync` 同步 549 篇、日期检查 477 篇通过；`pnpm check` 新增 TypeScript 诊断为 0；国内站 `pnpm build:cn` 成功生成 `/docs/overview`、`/docs/announcements/public-beta` 与 `/llms.txt`。
- 相关 49 项渠道/文档 parity 测试及 20 项日期测试通过；文档 validator 错误 0、断链 0。
- Gongfeng 查询证实第一批 MR !4679 已合并，因此本轮提交独立 MR。

## risks
- 首购优惠可能调整；文案引导以订阅页和支付页为准。
- 旧公告 URL 含 `public-beta`，保留路由兼容，页面正文与标题不再展示公测口径。

## validation
- `pnpm docs:sync`、文档日期检查、聚焦 Vitest、`pnpm check`、`validate_documentation.py`、`validate_change_impact.py --staged`。

## decisions
- 删除概览公测提示框；公告改为当前套餐与首购说明，保留既有 URL；同步国内站 `llms.txt`。
- 单项功能 Beta 保留，因为当前界面仍使用 Beta 标签。

## scan_scope
- 国内站 `frontend/src/content/docs/` 中文源；`frontend/src/app/llms.txt/route.next.ts` 国内分支。

## scan_output
- 有界搜索结果与 `git diff`，不保存完整扫描输出。

## handoff
- 本地门禁通过，待从最新 `master` 提交独立 MR；国际站不在本次范围。
