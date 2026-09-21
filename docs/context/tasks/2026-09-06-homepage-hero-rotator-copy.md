## goal

将国内站和国际站首页首屏轮播统一为七个经过确认的 AI 伙伴场景角色，并确保同 locale 内容刷新后轮播脚本重新绑定。

## non_goals

- 不修改轮播间隔、字号、颜色或其他首页文案。
- 不改动产品能力、知识库功能或站内其他“知识库”内容。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本地预览反馈（2026-09-06）：首页首屏轮播中的“知识库先不用了”。
- 用户本地预览反馈（2026-09-06）：最终确认国内站文案为“工作搭档 / 开发搭子 / 生活管家 / 理财助理 / 计划执行官 / 创意同行者”，并要求同步国内站和国际站。
- 用户追加反馈（2026-09-06）：新增“自媒体运营官”，英文使用两个单词的“content manager”。
- 用户本地预览反馈（2026-09-06）：文案更新后“工作搭档”停留在首项，不再轮播。
- 用户本地预览反馈（2026-09-06）：轮播变化增加动态效果。
- 用户本地预览反馈（2026-09-06）：角色字数变化导致“LightVela 可以成为你的”左右移动，要求前半句固定位置。

## interface_refs / data_structure_refs

- `rotatorWordsByLocale` 保持所有已发布 locale 的轮播项顺序与数量一致。
- 每个生成 fragment 的 `data-rotator-words` 与首个 `#hero-rotator` 文案保持一致。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：轮播文案由 importer 中的 locale 映射生成到九个静态 fragment，并由共享 runtime 轮播。
- `superseded_refs`：无。

## acceptance

- 所有 locale 均按相同场景与顺序展示七项轮播文案。
- 国内站精确使用用户确认的七项文案，首屏默认展示“工作搭档”。
- 同一 locale 的 fragment 内容发生替换后，旧脚本节点被清理并重新挂载到新 DOM。
- 每次切词使用不超过 200ms 的 `opacity` 与 `transform` 入场效果；离开视口或系统偏好减少动态时不播放。
- 国内站轮播时前缀“LightVela 可以成为你的”保持水平位置不变，角色词和下划线仍按内容自然变化。
- 首页聚焦测试、前端检查和文档门禁通过。

## affected_paths

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/runtime.js`
- `frontend/public/lightvela-intl-home/style.css`
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

- 九个生成 fragment 的 `data-rotator-words` 均为七项，首项与 `#hero-rotator` 一致。
- 实际运行时诊断：词组数据为七项、`prefers-reduced-motion` 为 `false`，但可见 DOM 没有运行时生成的测量节点；确认脚本仍绑定在 fragment 替换前的旧 DOM。
- 回归测试先失败：同 locale、同 markup 重渲染后，`#hero-rotator` 节点被替换并从“开发搭子”恢复为首项“工作搭档”。
- 修复及动效更新后首页聚焦测试 46/46 通过，覆盖同 locale 内容更新重绑、无关状态重渲染保留运行时 DOM，以及动效、离屏暂停和减少动态偏好约束。
- 国内站全新本地页面：初始显示“工作搭档”，登录态更新后运行时测量节点仍存在，并实际轮播到“理财助理”。
- 国内站浏览器实测：切换到“理财助理”时命中 `hero-rotator-in`，时长 `0.18s`，起始 `opacity: 0`、`translateY(6px)`；当前系统未启用减少动态效果。
- 国内站修复前浏览器测量：角色从 4 字“开发搭子”切到 5 字“计划执行官”时，前缀左坐标由 `173.95px` 变为 `159.95px`，确认存在 `14px` 横移。
- 国内站修复后浏览器测量：固定动态行宽 `483px`；“工作搭档”“理财助理”和最长的“自媒体运营官”下，前缀左坐标均为 `398.5px`；最长角色右边界 `879.7px` 未超过动态行右边界 `881.5px`。
- `pnpm check`：通过；首次类型检查遇到 Fumadocs 生成竞争，稳定后重跑完整门禁通过，TypeScript 新增诊断 0，现有 i18n 告警 48 个。
- `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`：46/46 通过；显式指定地址用于绕过本机 `localhost` 解析异常。
- `pnpm check`：通过；TypeScript 新增诊断 0，现有 i18n 告警 48 个。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：错误 0、告警 0、失效链接 0。
- `git diff --check`：通过。
- 772px 宽国内站本地预览：默认显示“工作搭档”，实际轮播数据精确为七项，页面宽度 772px、滚动宽度 772px，无横向溢出。

## risks

- 仅修改国内站会造成双站轮播角色不一致；同步更新所有 locale，并添加逐 fragment 断言。
- 动效可能造成不适或无意义的后台消耗；仅使用 `opacity`/`transform`，限制为 180ms，并在离屏或减少动态偏好下停止播放。
- 固定前缀时若直接给轮播词本身定宽会导致下划线长度失真；改为仅固定国内站整条动态行的宽度，角色词及下划线继续按内容自然伸缩。

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

- 精确搜索确认轮播数据由 `rotatorWordsByLocale` 注入 fragment 属性，共享 runtime 从该属性读取；React 脚本加载 effect 仅依赖 `locale`，同 locale 下替换 `markup` 不会重新绑定。

## handoff

- 本地修复、动效与浏览器验证完成；随现有 MR !3625 提交，最终状态以远端查询为准。
