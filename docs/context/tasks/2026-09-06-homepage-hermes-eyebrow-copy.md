## goal

将首页顶部眉题中的“云端 AI 伙伴”更新为“云端 Hermes Agent”。

## non_goals

- 不修改首页主标题、轮播角色、布局、动画或跳转。
- 不调整英文、日文、韩文、印尼文和西班牙文的现有眉题文案。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本地预览反馈（2026-09-06）：首页顶部的“云端 AI 伙伴”改成“云端 Hermes Agent”。

## interface_refs / data_structure_refs

- `coreCopyByLocale` 负责把首页标准眉题映射到各中文 locale。
- `replaceHeroCopy` 必须先把源站中文 Hermes 眉题归一到标准键，避免后续品牌替换误改 `Hermes Agent`。
- 生成 fragment 中 `.hero__eyebrow` 的可见文案、`aria-label` 与 `.sr-only` H1 必须一致。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：首页 importer 生成各 locale fragment，中文文案不能只手改生成物。
- `superseded_refs`：无。

## acceptance

- `zh-CN`、`zh-SG` 精确展示 `LightVela · 云端 Hermes Agent`。
- `zh-Hant` 精确展示 `LightVela · 雲端 Hermes Agent`。
- 三个中文 fragment 的可见文案、无障碍标签和唯一 H1 保持一致；其他语言不变。
- 首页聚焦测试、前端检查和文档门禁通过。

## affected_paths

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/public/lightvela-intl-home/index-fragment.zh-SG.html`
- `frontend/public/lightvela-intl-home/index-fragment.zh-Hant.html`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## required_context

- Pack：`frontend-product-surface`。
- 权威文件：`frontend/AGENTS.md`、`docs/context/project/services/frontend.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端硬规则和验证要求 | 约束生成物同步、Task Pack 与聚焦测试 |
| `docs/context/project/services/frontend.md@2.1.0` | 双站与 locale 验证边界 | 确认中文 locale 同步范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端生成物邻接 | 要求同步 importer、fragment 与测试 |
| `frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md` | 当前首页多语言集成设计 | 保持 importer 为生成真源 |

## evidence

- 先修改期望后运行首页聚焦测试：精确因 `zh-CN` 仍为旧文案而 1 项失败，证明回归断言有效。
- `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`：44/44 通过。
- `pnpm check`：通过；TypeScript 新增诊断 0，现有 i18n 告警 48 个。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：错误 0、告警 0、失效链接 0。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过；无额外设计映射或 owner review 要求。
- `git diff --check`：通过。
- 国内站本地预览的实际可访问树中，可见眉题和 H1 均为 `LightVela · 云端 Hermes Agent`。

## risks

- 只修改 fragment 会在下次 importer 运行时回退；同步修改生成规则并用逐 fragment 断言防回归。
- 通用 `Hermes Agent` 品牌替换可能误改眉题；先归一到 locale 映射键后再本地化。

## validation

- `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`
- `pnpm check`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`
- 国内站本地浏览器核验眉题和横向溢出。

## decisions

- 保留现有 `LightVela ·` 品牌前缀；只替换用户点名的中文短语。
- 新加坡简中与国内简中一致，繁中使用 `雲端`，其他 locale 保持现状。

## scan_scope

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output

- 精确搜索确认眉题由 importer 的 locale 映射生成，并同时写入可见文本、`aria-label` 与 `.sr-only` H1。

## handoff

- 本地实现和验证完成；随现有 MR !3625 提交，最终状态以远端查询为准。
