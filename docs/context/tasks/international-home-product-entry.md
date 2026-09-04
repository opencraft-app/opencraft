---
id: international-home-product-entry-task
type: task
scope: 恢复国际站新版首页登录态的产品入口。
triggers: ["international homepage product entry", "国际站首页开始使用", "Enter LightVela"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/international-home-product-entry.md
status: active
reviewed_at: 2026-09-04
review_due: 2026-09-11
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：国际站首页产品入口恢复

## goal

恢复国际站新版首页登录态 Header 中直达 `/agents` 的本地化产品入口。

## non_goals

- 不改变未登录态的语言切换与 `Sign In` 入口。
- 不新增免费试用按钮，不调整国内站首页或其他公共页面。
- 不修改认证、订阅、Agent 创建流程或静态首页主体结构。
- 不提交、推送、发布或修改外部服务。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-request-2026-09-04-international-home-product-entry`
- 用户指出新版国际站首页顶部导航缺少旧版已有的“开始使用”入口，并要求恢复。

## interface_refs / data_structure_refs

- `frontend/next-site/international-home-runtime.tsx`：新版国际站首页 Header 动作注入入口。
- `frontend/next-site/public-header-auth-island.tsx`：`showProductEntry`、`loginOnly` 与登录态渲染契约。
- 不变量：入口仅在登录态显示、目标始终为 `/agents`、文案按当前 locale 本地化。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md`、`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：旧版双站首页已实现登录态产品入口；国际站新版运行时接入 Header 时保留了 `loginOnly`，但未传入 `showProductEntry`。
- `superseded_refs`：无。

## acceptance

- 国际站新版首页向 Header Auth Island 传入 `showProductEntry`。
- 登录态桌面与移动 Header 显示当前 locale 的产品入口，点击目标为 `/agents`。
- 未登录态仍仅显示语言切换与本地化登录动作，不展示产品入口或免费试用按钮。
- 国内站现有行为与其他公共页面保持不变。

## affected_paths

- `frontend/next-site/international-home-runtime.tsx`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- `frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/international-home-product-entry.md`

## required_context

- `site-environment-routing`
- `frontend-product-surface`
- `frontend-service-detail`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 Context、验证与外部写入规则 | 限定实现、文档与交付边界 |
| `frontend/AGENTS.md@working-tree` | 前端服务级规则 | 确定 Header 视觉变更的聚焦测试与浏览器验证要求 |
| `docs/context/domains/site-environment-routing.md@working-tree` | 双站与 locale 路由边界 | 确认国际站运行时与国内站需分别验证 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务 Context | 确认 Next 公开站入口与验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 运行时、OpenSpec 与 i18n 邻接关系 | 确认既有 Header 入口设计需要同步 |
| `frontend/openspec/changes/2026-08-31-homepage-auth-entry-design.md@working-tree` | 旧版双站登录态入口设计 | 复用既有文案、目标与状态契约 |

## evidence

- 修改前源码精确搜索确认 `InternationalHomeRuntime` 仅传入 `loginOnly`，未传入 `showProductEntry`；Header 组件已完整实现登录态入口与八种 locale 文案。
- 未登录国际站现网页面可见语言切换与 `Sign In`，未展示产品入口，符合需保持的匿名状态基线。
- 国际站运行时与公共 Header 聚焦测试通过：2 个测试文件、21 个用例通过。
- `pnpm check` 通过：i18n 与文档校验通过，TypeScript 诊断 191，基线 276，新增 0。
- `pnpm build:global` 通过：606 个静态页面生成完成，SEO 与静态产物检查通过。
- 本地国际站 5174 首页渲染完整，匿名 Header 的可访问性树包含 `Change language` 与 `Sign In`；认证服务在本地不可达，因此真实登录态截图留待具备会话的预览环境补充。
- Web 验证报告：`/tmp/lightvela-global-home-entry-validation-2026-09-04/report.html`。

## risks

- `showProductEntry` 若影响未登录态，会改变新版 Header 方案；由 Auth Island 匿名态回归测试证明该开关仅作用于登录态。
- 真实登录态现网验证受当前浏览器会话无登录态限制；以组件状态测试、本地国际站渲染和源码契约共同验证，并明确记录限制。

## validation

- `pnpm vitest run next-site/__tests__/international-home-rendering.test.tsx next-site/__tests__/public-header-auth-island.test.tsx`
- `pnpm check`
- 国际站本地预览的桌面与移动 Header 检查。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions

- 仅向国际站运行时补传已有 `showProductEntry`，继续保留 `loginOnly`；不复制 Header 逻辑或新增入口组件。owner 为 `wisp/mono2-maintainers`。

## scan_scope

- `frontend/next-site/international-home-runtime.tsx`
- `frontend/next-site/public-header-auth-island.tsx`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- `frontend/next-site/__tests__/public-header-auth-island.test.tsx`
- `frontend/openspec/changes/2026-08-31-homepage-auth-entry-*`

## scan_output

- 精确搜索确认国内站 `PublicHomePage` 已传入 `showProductEntry`；缺口仅在国际站新版运行时，无需修改公共 Header 组件或 locale 词典。

## handoff

- 本地实现、聚焦测试、全量前端检查、国际站构建与匿名浏览器验证完成；真实登录态页面截图受会话限制未闭环。未提交、未推送、未发布。
