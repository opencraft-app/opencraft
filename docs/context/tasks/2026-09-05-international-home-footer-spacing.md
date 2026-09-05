## goal

收紧国际站首页底部 Hermes Agent CTA 与前后内容之间的纵向留白。

## non_goals

- 不修改文案、字体、按钮、Footer 链接或国内站页面。
- 不改动其他首页区块的布局。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户截图（2026-09-05）：`把想法交给 Hermes Agent，让它们在云端持续推进。` 板块上下空白间距调小。

## interface_refs / data_structure_refs

- 无 API 或数据结构变更；保持八个国际站 locale 共用同一生成样式。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：国际站首页样式由 `frontend/scripts/import-international-homepage.mjs` 生成到 `frontend/public/lightvela-intl-home/style.css`。
- `superseded_refs`：无。

## acceptance

- 桌面端 CTA 顶部、CTA 与 Footer 链接区之间的留白均小于当前值。
- 平板和手机断点继续按比例收紧，无横向布局变化。
- 国际站首页聚焦测试、前端检查与 diff 检查通过。

## affected_paths

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## required_context

- Pack：`frontend-product-surface`。
- 权威文件：`frontend/AGENTS.md`、`docs/context/project/services/frontend.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务边界与视觉验证要求 | 确定聚焦测试与视觉检查范围 |
| `frontend/AGENTS.md` | 前端硬规则与门禁 | 约束最小变更和验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 国际首页生成物邻接 | 确认同步修改生成源、产物和测试 |
| `frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md` | 当前国际首页集成约束 | 保持所有已发布 locale 共用布局 |

## evidence

- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx`：基于最新 `origin/master`，31/31 通过。
- `pnpm check`：通过；TypeScript 0 个新增诊断，现有 i18n 告警 48 个。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：错误 0、告警 0、失效链接 0。
- `git diff --check`：通过。
- 1644×944 国际站桌面预览：CTA 与 Footer 链接区纵向留白收紧，标题/按钮仍居中。
- 390×844 国际站移动预览：无横向溢出（`scrollWidth === clientWidth === 390`），Footer 两列布局正常。
- 本地预览同时出现与本次样式改动无关的认证服务不可用及 fragment script 开发态告警；页面主体与本次目标区块仍正常渲染。

## risks

- 留白缩减过多会让 CTA 与 Footer 链接区拥挤；采用桌面、平板、手机逐级缩减的既有响应式结构，并做截图检查。

## validation

- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx`
- `pnpm check`
- `git diff --check`
- 桌面与移动视口聚焦截图检查。

## decisions

- 仅调整 `.foot`、`.foot__top`、`.foot__links` 的纵向尺寸，不改内容或交互。

## scan_scope

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output

- 精确搜索确认 CTA 由 `footerRefreshCss` 生成，所有 locale 共用 `style.css`。

## handoff

- 实现和本地验证完成；未提交、未推送、未发布。
