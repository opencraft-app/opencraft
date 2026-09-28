---
id: cn-docs-batch-one-2026-09-27
type: task
scope: 国内站中文文档三批优化的第一批事实修正与钉钉接入指南。
triggers: ["cn docs", "国内站文档", "钉钉接入指南"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/content/docs/
  - frontend/src/config/docs-sidebar.ts
status: active
reviewed_at: 2026-09-27
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

## goal
完成国内站中文文档三批优化中的第一批：先修正高频入口的过时事实与矛盾，并为已支持的钉钉通道提供可用的基础指南。

## non_goals
- 本批不调整国际站文档，不重排全部目录，不补齐全部场景页。
- 不推断钉钉开放平台的应用类型、权限或回调要求。
- 不提交、推送、发布或宣称线上已更新。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮要求：分三批实现，先改最重要的，后两批逐步优化；仅国内站中文文档。

## interface_refs / data_structure_refs
- `frontend/src/config/docs-sidebar.ts`：`CN_SIDEBAR` 与 `CN_SLUG_TO_FILE` 必须同时注册新页面。
- `frontend/scripts/sync-fumadocs-content.mjs`：`cnDocs` 必须收录新页面。
- `frontend/src/pages/marketing/agent-channel-panel.tsx`：钉钉支持扫码或 Client ID / Secret。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md` 的文档区域和 Agent 创建引导边界。
- relevant_evolution: 当前中文 FAQ、开通页与模型页对同一能力有相互冲突的描述；`wiki/product-state/geo-fact-table.md` C8 记录钉钉文档缺口。
- superseded_refs: 旧版三卡片管理台截图与“订阅后自动创建”流程仅供历史参考。

## acceptance
- 首次开通、模型切换、企业微信支持状态在高频文档中一致。
- 钉钉指南在国内站三处路由注册，可从核心概念页到达。
- 文档同步、日期检查、聚焦测试、前端检查及 context 门禁通过。

## affected_paths
- `frontend/src/content/docs/`、`frontend/src/config/docs-sidebar.ts`、`frontend/scripts/sync-fumadocs-content.mjs`、相关文档契约测试与正式设计。

## required_context
- Pack: `agent-gateway-runtime`; site routing impact: `site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@HEAD` | 路由 must_read | 区分 Agent 运行时与用户文档口径 |
| `frontend/AGENTS.md@HEAD` | 服务级规则 | 前端验证和区域边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查文档契约测试与配置邻居 |
| `frontend/src/content/docs/__tests__/channel-consistency.test.ts@HEAD` | 测试邻居 | 更新钉钉链接约束 |
| `docs/engineering/domains/site-environment-routing.md@HEAD` | 现行设计 | 校准创建引导及区域隔离 |
| `docs/context/tasks/TASK-TEMPLATE.md@HEAD` | Task Pack 模板 | 保持交接状态 |

## evidence
- `pnpm docs:sync`：通过，生成 549 篇文档；国内站路由清单新增钉钉。
- `pnpm check`：通过，TypeScript 171 个诊断与基线一致，新增 0。
- `pnpm build:cn`：通过，国内站静态页面及文档路由生成成功。
- 聚焦渠道一致性和日期测试：25 项通过；改动文档的摘要与相对链接检查通过。
- 仓库文档 validator：错误 0、断链 0。
- 扩展文档测试的 3 项失败分别来自原有国际场景页缺摘要与仓库中既有超大图片；本批 3 篇新摘要已补加粗结论。

## risks
- 生产界面可能落后于源码：文档采用稳定流程描述，正式发布前仍需登录态线上验收。
- 钉钉开放平台前置条件尚未核实：仅提供已由产品界面支持的扫码与凭证入口。

## validation
- `pnpm docs:sync`、聚焦 Vitest、`pnpm check`、文档与变更影响检查；线上登录态流程待发布前核实。

## decisions
- 第一批（本次）：修正首次开通、配置总览、模型、FAQ 的高频错误，补钉钉扫码优先的基础指南及三处入口；验收以路由、链接、日期、构建和聚焦测试为准。
- 第二批：按“开始使用 → Bot 与模型 → 通道与技能 → 自动化与资料 → 管理与排障”重组国内站任务导航；逐页核对 Bot 切换、网页对话、技能、记忆、人设、云存储、诊断和实验功能的入口及权限，补齐具体操作和失败恢复路径。先形成页面到当前产品入口的覆盖矩阵，再改目录和正文；验收不出现孤儿页、重复入口或超前能力描述。
- 第三批：将场景教程与原理长文分层，清理营销比较页在任务导航中的干扰；核对套餐、积分、截图、更新时间与 SEO/llms 口径，建立发布前的文档回归清单。验收为国内站用户能按目标找到教程，且变更后自动检查断链、区域映射、日期与高风险事实。

## scan_scope
- 国内站文档源、注册表、通道面板、创建引导与模型配置相关目录。

## scan_output
- 有界 `rg` 与目标文件读取；未保存完整扫描输出。

## handoff
- 第一批在独立 worktree 本地完成，尚未提交、推送或发布；后两批尚未实施。
