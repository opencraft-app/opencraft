## goal

收紧国内站与国际站首页底部 Hermes Agent CTA 与前后内容之间的纵向留白。

## non_goals

- 不修改文案、字体、按钮或 Footer 链接。
- 不改动其他首页区块的布局。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户截图（2026-09-05）：`把想法交给 Hermes Agent，让它们在云端持续推进。` 板块上下空白间距调小。
- 用户国内站截图（2026-09-06）：上一段 CTA 与 Hermes Agent 标题之间仍有大面积留白，需继续收紧。

## interface_refs / data_structure_refs

- 无 API 或数据结构变更；保持八个国际站 locale 共用同一生成样式。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：国际站首页样式由 `frontend/scripts/import-international-homepage.mjs` 生成到 `frontend/public/lightvela-intl-home/style.css`。
- `superseded_refs`：无。

## acceptance

- 桌面端上一段 CTA 与 Hermes Agent 标题之间、Hermes Agent CTA 与 Footer 链接区之间的留白均小于当前值。
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

- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx`：追加修正后 31/31 通过。
- `pnpm check`：追加修正后通过；TypeScript 0 个新增诊断，现有 i18n 告警 48 个。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：错误 0、告警 0、失效链接 0。
- `git diff --check`：通过。
- 1687×972 国内站桌面预览：上一段 CTA 底部与 Footer 顶部的总布局留白由 192px 收紧为 80px，标题/按钮仍居中，无横向溢出。
- 390×844 国内站移动预览：对应总布局留白为 72px，无横向溢出，Footer 两列布局正常。
- 本地预览同时出现与本次样式改动无关的认证服务不可用及 fragment script 开发态告警；页面主体与本次目标区块仍正常渲染。

## risks

- 留白缩减过多会让 CTA 与 Footer 链接区拥挤；采用桌面、平板、手机逐级缩减的既有响应式结构，并做截图检查。

## validation

- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx`
- `pnpm check`
- `git diff --check`
- 桌面与移动视口聚焦截图检查。

## decisions

- 调整上一段 `.cta` 的底部留白，以及 `.foot`、`.foot__top`、`.foot__links` 的纵向尺寸，不改内容或交互。

## scan_scope

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output

- 精确搜索和桌面端几何测量确认，大空洞由上一段 `.cta` 的 `padding-bottom: 120px` 与 `.foot` 顶部留白叠加产生；所有 locale 共用 `style.css`。

## handoff

- 实现和本地验证完成，已提交到 MR !3622；远端流水线待完成，未合并、未发布。
