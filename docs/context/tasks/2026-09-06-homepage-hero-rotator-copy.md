## goal

将国内站和国际站首页首屏轮播统一为六个经过确认的 AI 伙伴场景角色。

## non_goals

- 不修改轮播动画、速度、样式或其他首页文案。
- 不改动产品能力、知识库功能或站内其他“知识库”内容。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本地预览反馈（2026-09-06）：首页首屏轮播中的“知识库先不用了”。
- 用户本地预览反馈（2026-09-06）：最终确认国内站文案为“工作搭档 / 开发搭子 / 生活管家 / 理财助理 / 计划执行官 / 创意同行者”，并要求同步国内站和国际站。

## interface_refs / data_structure_refs

- `rotatorWordsByLocale` 保持所有已发布 locale 的轮播项顺序与数量一致。
- 每个生成 fragment 的 `data-rotator-words` 与首个 `#hero-rotator` 文案保持一致。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：轮播文案由 importer 中的 locale 映射生成到九个静态 fragment，并由共享 runtime 轮播。
- `superseded_refs`：无。

## acceptance

- 所有 locale 均按相同场景与顺序展示六项轮播文案。
- 国内站精确使用用户确认的六项文案，首屏默认展示“工作搭档”。
- 首页聚焦测试、前端检查和文档门禁通过。

## affected_paths

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/runtime.js`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/next-site/international-home-runtime.tsx`
- `frontend/next-site/__tests__/international-home-page.test.tsx`
- `frontend/next-site/__tests__/international-home-rendering.test.tsx`

## required_context

- Pack：`frontend-product-surface`。
- 权威文件：`frontend/AGENTS.md`、`docs/context/project/services/frontend.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端硬规则和验证要求 | 约束生成物同步及聚焦测试 |
| `docs/context/project/services/frontend.md@2.1.0` | 双站与 locale 验证边界 | 要求所有发布 locale 保持一致 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端 locale 生成邻接 | 确认同步 importer、fragment、runtime 和测试 |
| `frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md` | 当前首页多语言集成约束 | 保持语言切换后 runtime 数据一致 |

## evidence

- 九个生成 fragment 的 `data-rotator-words` 均为六项，首项与 `#hero-rotator` 一致。
- `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`：44/44 通过；显式指定地址用于绕过本机 `localhost` 解析异常。
- `pnpm check`：通过；TypeScript 新增诊断 0，现有 i18n 告警 48 个。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：错误 0、告警 0、失效链接 0。
- `git diff --check`：通过。
- 772px 宽国内站本地预览：默认显示“工作搭档”，实际轮播数据精确为六项，页面宽度 772px、滚动宽度 772px，无横向溢出。

## risks

- 仅修改国内站会造成双站轮播角色不一致；同步更新所有 locale，并添加逐 fragment 断言。

## validation

- `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`
- `pnpm check`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions

- 将用户确认的中文角色作为国内站文案权威来源；其他 locale 使用对应场景的自然翻译，不机械直译“搭子”。

## scan_scope

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/public/lightvela-intl-home/runtime.js`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output

- 精确搜索确认轮播数据由 `rotatorWordsByLocale` 注入 fragment 属性，共享 runtime 从该属性读取。

## handoff

- 本地实现与验证完成；按用户确认追加至现有 MR !3625，最终状态以提交后的远端查询为准。
