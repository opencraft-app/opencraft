# OPT-006：双站移动端首页页脚下方出现 `\n`

## goal

消除国内站与国际站首页页脚下方可见的字面量 `\n`，修复首页静态片段导入流程，避免重新生成时复发。

## non_goals

- 不调整页脚栏目、文案、链接或移动端布局。
- 不修改非首页页面。

## requirement_ids / requirement_refs / requirement_excerpt

- OPT-006；[TAPD 卡片](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138690655)。用户截图：双站移动端页面左下角有可见转义符。

## interface_refs / data_structure_refs

- `frontend/next-site/international-home-page.tsx` 按 locale 读取 `public/lightvela-intl-home/index-fragment.*.html`。
- `frontend/next-site/international-home-runtime.tsx` 用 `dangerouslySetInnerHTML` 输出片段。
- `frontend/scripts/import-international-homepage.mjs` 负责生成国际站片段；国内站片段在完整导入时沿用仓库内文件。

## history_context

- `current_design_refs`：`frontend/openspec/plan.md` 的首页 Footer 验收段；`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：国内、国际首页共用同一静态片段渲染路径，因此同一尾部字符在两个站点可见。

## acceptance

- 所有已发布 locale 的首页静态片段在根容器下没有字面量 `\n` 文本节点。
- 国内、国际移动端预览页脚下方不显示该字符；预览和 master 的页面资源可区分。
- 提交前 CR、聚焦测试、前端检查、双站构建完成，准备 MR 草稿后等待用户确认。

## affected_paths

- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## required_context

- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@96d19592f` | 仓库交付规则 | Task Pack 与验证要求 |
| `frontend/AGENTS.md@96d19592f` | 前端规则 | 双站与聚焦测试要求 |
| `docs/context/project/services/frontend.md@96d19592f` | 服务边界 | 静态首页为前端交付面 |
| `docs/context/domains/site-environment-routing.md@96d19592f` | 双站要求 | 国内、国际都验证 |

## evidence

- 2026-09-29：生产 `https://lightvela.com/` 与 `https://lightvela.ai/` 的 HTML 均在首页片段 `</footer>` 后出现 `</div>\\n`，对应截图底部的可见 `\n`。
- `rg -n -F '\n' frontend/public/lightvela-intl-home --glob '*.html'` 命中全部 9 个片段的最后一行。
- 修复：删除 9 个片段尾部字面量；导入脚本只删除源 HTML `body` 的独立 `\n` 文本节点，保留正常换行和内部内容。

## risks

- 导入脚本可能再次从带有该字符的静态来源生成文件；在导入时清理独立尾部文本并补片段回归测试。
- 现有 `international-home-page.test.tsx` 中 3 项 PNG 资产预期与当前 WEBP 产物不一致；与本次变更无关，需在交付说明列明。

## validation

- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx -t 'literal newline escape'`：1/1 通过。
- 完整相关套件：64/67 通过；3 项失败均为历史 PNG 预期与 WEBP 文件不符。
- `pnpm check` 通过（TypeScript 0 个新增诊断）；`pnpm build` 和 `pnpm build:global` 均通过。
- 国际站静态构建的 `out/index.html` 中字面量 `\\n` 计数为 0；9 个片段回归测试全部覆盖。
- `validate_change_impact.py --repo . --staged` 通过；无映射的正式设计或 owner CR 强制项。
- 待补：预览验收。

## decisions

- 修复静态片段和导入器；不以 CSS 隐藏文案，因为源 HTML 中存在可见文字。
- 提交前 CR：逐项核对 9 个静态片段仅删除尾部同一个字面量，导入脚本仅处理 `body` 顶层独立 `\\n` 文本节点；未发现阻断问题。完整相关套件的 3 项失败与本次改动无关，属于旧 PNG 资源断言。

## MR draft

- 标题：`fix(home): remove visible newline escape from mobile footer`
- 源/目标：`frontsandbox/mobile-stray-escape-20260929` → `master`
- 描述：清除国内与国际首页各 locale 静态片段页脚后的字面量 `\\n`；导入器剔除来源文件独立的同类文本节点；补全 locale 回归测试。
- 验证：聚焦回归 1/1、`pnpm check`、国内与国际生产构建、变更影响检查通过；相关套件 64/67，3 项旧 PNG→WEBP 断言失败。
- 风险：预览发布后需双站移动端实际验收；无需后端或数据迁移。

## scan_scope

- `frontend/public/lightvela-intl-home/`、`frontend/scripts/import-international-homepage.mjs`、`frontend/next-site/`。

## scan_output

- 有界检索结果见本任务 evidence。

## handoff

- 当前：实现、提交前 CR、聚焦回归与双站构建完成；继续预览推送和双站移动端验收。MR 草稿已准备，创建需用户确认。
