## goal

调整国内站首页页脚“产品”栏的试用、定价文案，并将五个渠道接入指引调整为用户确认的顺序。

## non_goals

- 不修改链接目标、文案、页脚样式或其他栏目。
- 不修改国际站及其他 locale 的页脚。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本地预览反馈（2026-09-06）：国内站首页页脚红框内顺序改为“微信、飞书、QQ、企微、钉钉”。
- 用户本地预览反馈（2026-09-06）：将“14 天免费试用”改为“免费试用”，将“定价”改为“产品定价”。

## interface_refs / data_structure_refs

- 国内站静态 fragment 的“产品”栏目前两项使用“免费试用”“产品定价”，随后五个渠道链接按确认顺序展示。
- 每个渠道链接的 `href` 保持不变。

## history_context

- `current_design_refs`：`frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md`。
- `relevant_evolution`：国内站页脚已有独立的渠道接入入口和聚焦回归测试。
- `superseded_refs`：无。

## acceptance

- 国内站页脚“产品”栏目按“免费试用、产品定价、微信、飞书、QQ、企微、钉钉”展示。
- 五个渠道链接目标与修改前一致。
- 国际站 fragment 不发生变化。
- 聚焦测试、前端检查、文档及变更影响门禁通过。

## affected_paths

- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## required_context

- Pack：`frontend-product-surface`；路由器同时弱命中 `agent-gateway-runtime`，本次不修改真实渠道能力或网关。
- 权威文件：`frontend/AGENTS.md`、`docs/context/project/services/frontend.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md` | 前端视觉与测试硬规则 | 要求以聚焦测试和浏览器验证顺序 |
| `docs/context/project/services/frontend.md@2.1.0` | 双站产品边界 | 将改动严格限定为国内站 fragment |
| `docs/context/domains/agent-gateway-runtime.md@2.0.0` | 路由器因 channel 词命中 | 确认本次仅重排文档入口，不涉及运行时渠道行为 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 静态 fragment 与相邻测试邻接 | 检查生成物、测试和已归档首页方案 |
| `frontend/openspec/changes/2026-08-31-intl-homepage-integration-implementation-plan.md` | 首页 fragment 接入历史 | 保持正式路由、区域边界和回归覆盖 |

## evidence

- 回归测试先失败：收到旧顺序“QQ、微信、企微、钉钉、飞书”，期望新顺序“微信、飞书、QQ、企微、钉钉”。
- 修改后 `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx`：32/32 通过。
- 国内站本地浏览器实际 DOM 顺序为“微信、飞书、QQ、企微、钉钉”，对应 `href` 分别保持为 WeChat、Feishu、QQ、WeCom 和钉钉原有路由。
- `pnpm check`：通过；TypeScript 新增诊断 0，现有 i18n 告警 48 个；Fumadocs source race 由门禁内置重试后恢复。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：错误 0、告警 0、失效链接 0。
- `git diff --check`：通过。

## risks

- 只改测试或只改页面会造成契约漂移；两处同步更新并在浏览器读取实际 DOM 顺序。
- 误改国际站会扩大范围；校验非 `zh-CN` fragment 无差异。

## validation

- `pnpm exec vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx`
- `pnpm check`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions

- 保留现有“接入企微指引”展示文案，将用户所说“企微”理解为该现有入口；只调整位置。

## scan_scope

- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment.zh-CN.html`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output

- 精确搜索确认当前国内站页脚顺序由 `index-fragment.zh-CN.html` 承载，相邻测试完整断言栏目顺序和链接。

## handoff

- 本地实现与浏览器验证完成；随现有 MR !3625 提交，最终状态以远端查询为准。
