## goal
移除国内首页左下角版权文案中的英文 `Copyright` 和中文 `版权所有`，让线上首页与共享 `LegalFooter` 的精简版权口径一致。

## non_goals
- 不调整国际站 footer、链接列、备案号、布局或视觉间距。
- 不修改共享 `LegalFooter` 已有翻译。
- 不提交、推送、创建 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈：`lightvela.com` 首页左下角看起来又出现 `Copyright © 2026`，期望沿用最近 MR 的 `© 2026 LightVela · 腾讯轻量云出品` 口径。

## interface_refs / data_structure_refs
- 无 API、Schema、配置或数据结构变更。

## history_context
- `current_design_refs`：国内首页使用 `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html` 的静态片段；`frontend/scripts/import-international-homepage.mjs` 会保留该国内片段。
- `relevant_evolution`：MR !3718 中共享 `LegalFooter` 已改为 `© {{year}} LightVela · 腾讯轻量云出品`，但国内首页静态片段未同步。
- `superseded_refs`：旧国内首页片段中的 `Copyright © 2026 LightVela 版权所有 ·` 与中间态 `© 2026 LightVela 版权所有 ·`。

## acceptance
- 国内首页左下角显示 `© 2026 LightVela ·`，不再显示 `Copyright © 2026 LightVela 版权所有` 或 `© 2026 LightVela 版权所有`。
- 备案链接、`腾讯轻量云出品` 换行和产品列保持不变。
- 首页聚焦测试通过。

## affected_paths
- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## required_context
- `frontend-product-surface`
- `tapd-gongfeng-delivery`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@87337759f` | 前端服务本地规则 | 确认前端验证入口 |
| `docs/context/project/services/frontend.md@87337759f` | 产品页面上下文 | 确认双站和静态产物边界 |
| `docs/context/flows/tapd-gongfeng-delivery.md@87337759f` | MR/发布边界 | 区分源码改动、MR、发布状态 |
| `.agents/skills/gongfeng/SKILL.md@87337759f` | Gongfeng 查询规则 | 只读查询 MR 状态，不做写操作 |

## evidence
- `rg` 确认 `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html` 只保留 `© 2026 LightVela ·<br>腾讯轻量云出品`，旧 `Copyright © 2026 LightVela 版权所有` 与 `© 2026 LightVela 版权所有` 仅作为测试/guard 禁止串出现。
- `git diff --check`：通过。
- `corepack pnpm@10.23.0 exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx`：1 个测试文件、35 项通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：docs-impact passed。
- `corepack pnpm@10.23.0 check`：通过，i18n 结构错误 0，TypeScript 新增诊断 0。

## risks
- 风险：下次运行 importer 时重新带回旧串。缓解：在 importer 国内片段保护中禁止 `Copyright © 2026 LightVela 版权所有` 与 `© 2026 LightVela 版权所有`。
- 回滚：恢复 `index-fragment.zh-CN.html`、测试断言和 importer guard 的三处改动。

## validation
- `git diff --check`
- `corepack pnpm@10.23.0 exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 决策：只改国内首页静态片段，不碰国际站或共享 `LegalFooter`。

## scan_scope
- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output
- 使用 `rg` 定位 `Copyright © 2026 LightVela 版权所有` 与 `foot__brand-copy`。

## handoff
- 当前为本地已 stage 改动，尚未提交、推送、创建 MR 或发布。
