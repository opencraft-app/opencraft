## goal
让已确认有套餐资格的登录用户尽早看到首页顶部“开始使用”和头像菜单“我的智能体”入口。

## non_goals
- 不改变购买前隐藏入口、/agents 路由门禁、Hero CTA 分流、认证或后端查询。
- 不合并 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-07 截图反馈及随后确认：套餐已能证明资格时立即显示顶部入口；只有资格仍需智能体列表证明时才等待列表。
- 用户后续授权将本轮首页入口与文案、导航改动提交为 MR。
- `wiki/prd-docs/2026-09-30-pricing-modal-and-first-bot-onboarding.md`：购买前隐藏“我的智能体”入口；老用户到期管理不在变更范围。

## interface_refs / data_structure_refs
- `OpenClawContextValue` 的 `hasResolvedPasses`、`passesLoading`、`passesError`、`isSubscribed`、`latestPass`、`bots`、`botsLoading`、`botsError`。
- 顶部和菜单入口的目标保持 `/agents`；资格已确定时不依赖 Bot 列表完成。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`；上述 PRD。
- relevant_evolution: 当前主线顶部和菜单均等待 Bot 列表，Hero CTA 只等待权益状态，造成可见性错位。
- superseded_refs: `frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md` 只解释最初增加入口的设计，早于购买前隐藏规则。

## acceptance
- 已确认有有效或历史套餐时，Bot 列表加载中或失败也显示顶部和菜单入口。
- 仅靠 Bot 证明资格时，列表完成且成功后才显示；无资格、权益未确认或失败时隐藏。
- 双入口沿用原有文案、链接、埋点与页面范围。

## affected_paths
- `frontend/src/lib/cta-journey.ts`
- `frontend/next-site/public-header-auth-island.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- 对应聚焦测试与 `docs/engineering/domains/site-environment-routing.md`

## required_context
- frontend-product-surface、site-environment-routing、identity-access。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@20ee7b3d9` | 服务约束 | 前端验证范围 |
| `docs/context/domains/site-environment-routing.md@20ee7b3d9` | 双站边界 | 国内国际共用入口 |
| `docs/context/domains/identity-access.md@20ee7b3d9` | 会话边界 | 保留认证等待 |
| `frontend/AGENTS.md@20ee7b3d9` | 服务门禁 | 检查、测试、构建 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@20ee7b3d9` | 邻接 | 检查相邻组件测试 |
| `wiki/prd-docs/2026-09-30-pricing-modal-and-first-bot-onboarding.md@20ee7b3d9` | 产品资格 | 保留购买前隐藏 |
| `frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md@20ee7b3d9` | 历史设计 | 保留首页入口范围 |

## evidence
- 用户截图：Hero CTA 已可见，顶部两个入口仍未显示。
- 当前主线与线上首屏 HTML：Hero 为静态片段，Header 初始为认证占位。
- `pnpm exec vitest run --config vitest.config.ts --api.host 127.0.0.1` 聚焦三文件：73/75 通过；两条“模型入口”测试失败，在未修改的主线组件上同样复现。
- 本次新增行为的 6 条聚焦用例再次单独运行，6/6 通过。
- `pnpm check` 通过（TypeScript 0 个新增诊断）；`pnpm build:cn`、`pnpm build:global` 均通过。
- `npm --prefix opencraft run check:mono2-agent-console` 通过；`validate_documentation.py` 和 `validate_change_impact.py --staged` 通过；`git diff --check` 通过。
- 全量 Vitest 运行约三分半后出现单个持续高内存 worker，手动中止，未得到完整测试结论。
- `pnpm check:homepage-performance` 未通过：脚本 33（预算 22），raw 4,199,450 B（预算 2,457,600 B），gzip 1,469,849 B（预算 819,200 B）；这次改动未新增脚本资源。

## risks
- Bot 是唯一资格证据的旧账号仍需等待列表；保留其错误门禁。
- 仅修改前端展示时序，不扩大后端访问权限。

## validation
- 聚焦 Vitest、`pnpm check`、`pnpm test`、`pnpm build`、OpenCraft 同步只读检查、change-impact 检查。

## decisions
- 顶部与菜单使用同一资格函数；权益确认仍是先决条件。用户在本聊天确认。

## scan_scope
- `frontend/next-site/public-header-auth-island.tsx`、`frontend/src/components/site/user-avatar-menu.tsx`、相邻测试及 `frontend/src/lib/cta-journey.ts`。

## scan_output
- 精确搜索命中两处等待 `botsLoading` / `botsError` 的入口条件。

## handoff
- 实现与必要检查已完成；完整测试和首页资源预算未通过，见 evidence。真实登录态浏览器时序仍待部署到预览环境后验证。交由 MR 评审，未合并、未发布。
