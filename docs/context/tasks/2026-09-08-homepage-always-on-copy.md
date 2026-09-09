## goal
优化 LightVela 首页“之后，我会一直都在”卡片文案，明确云端 7×24 在线，并以持续协作和反馈适应用户偏好，替代“每次纠正都写成新规则”的不准确承诺。

## non_goals
- 不调整卡片标题、插图、列表项、布局或交互。
- 不改变 Hermes 运行时、记忆机制或规则写入逻辑。
- 不发布、合并或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-08）：加入“七乘二十四在线”表达，并优化 Hermes 自我进化描述，避免“你每纠正我一次，我就把它记成新规则”的不准确说法。

## interface_refs / data_structure_refs
- `frontend/scripts/import-international-homepage.mjs`：首页本地化、强调片段与静态产物生成入口。
- `frontend/public/lightvela-intl-home/index-fragment*.html`：各公开 locale 的首页静态片段。
- `frontend/next-site/__tests__/international-home-page.test.tsx`：首页片段及多语言一致性回归。

## history_context
- `current_design_refs`：`docs/context/domains/site-environment-routing.md`、`frontend/AGENTS.md`。
- `relevant_evolution`：首页已使用“长期在线、持续进化”的产品定位；本次把卡片说明收敛为云端常驻、逐步理解偏好和根据反馈持续调整。
- `superseded_refs`：旧文案声称每次纠正都会保存为新规则，不再作为用户可见能力承诺。

## acceptance
- 中文卡片展示“云端 7×24 小时在线”，不再出现“每次纠正”“新规则”表述。
- 文案改为随着协作逐步理解偏好，并根据反馈持续调整。
- 英文、繁中、西语、印尼语、日语、韩语语义一致。
- importer、已提交静态片段和回归测试保持一致，桌面与移动端无明显排版问题。

## affected_paths
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/next-site/__tests__/international-home-page.test.tsx`
- `docs/context/tasks/2026-09-08-homepage-always-on-copy.md`

## required_context
- `site-environment-routing`
- `frontend-service-detail`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 国内与国际站是独立交付面 | 要求逐 locale 校验静态片段 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端验证边界 | 确定聚焦测试与类型门禁 |
| `frontend/AGENTS.md@working-tree` | 前端实现硬规则 | 保持文案级最小改动并补视觉验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 首页生成物与多语言邻接 | 同步 importer、静态片段和测试 |

## evidence
- 精确搜索定位旧文案存在于 importer、本地化静态片段和首页回归测试。
- `pnpm vitest run --api.host=127.0.0.1 next-site/__tests__/international-home-page.test.tsx next-site/__tests__/international-home-rendering.test.tsx`：2 个测试文件、49 个测试全部通过。
- `pnpm check`：i18n、繁中生成检查、文档时间检查通过；TypeScript 相对基线 0 个新增问题。
- 国内站本地预览 `http://localhost:5174/` 已核验：最终短文案正确渲染，移动端卡片无溢出或异常换行。

## risks
- 只改静态片段会被后续 importer 再生成覆盖；同步维护生成入口和产物缓解。
- 新文案更长，可能造成卡片高度或移动端换行变化；通过桌面和移动端截图核验。

## validation
- 聚焦 `international-home-page` 测试。
- `pnpm check`。
- 国内站桌面与移动端首页浏览器核验。
- 国际站至少核验英文及 locale 静态产物。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 中文采用“协作越久，我越懂你的偏好，也会根据反馈持续调整”，避免把自我适应机制简化为逐条规则写入，并控制卡片文案长度。
- 7×24 在线和持续适应两处使用现有卡片的 `<b>` 强调样式，不引入新样式。
- 同步所有公开语言，避免同一卡片在不同 locale 保留不一致的能力承诺。

## scan_scope
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output
- 无独立扫描产物；精确搜索结果记录于任务执行日志。

## handoff
- 实现与本地验证完成；待用户确认后提交并推送至现有 MR !3717。
