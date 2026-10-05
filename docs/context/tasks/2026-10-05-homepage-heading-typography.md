## goal
让国际站首页“How to Get Started”标题使用与“Core features of LightVela”和“What LightVela Can Do”一致的无衬线字体，并核对国内站对应标题。

## non_goals
- 不调整正文、字号、文案、布局或发布状态。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 三张截图：截图 1 的标题字体与截图 2、3 不一致；检查国内站是否也需调整。

## interface_refs / data_structure_refs
- `frontend/next-site/international-home-runtime.tsx` 加载静态首页 CSS。
- `frontend/scripts/import-international-homepage.mjs` 生成 `frontend/public/lightvela-intl-home/style.css`。

## history_context
- current_design_refs: `frontend/openspec/specs/marketing.md`、`docs/context/domains/site-environment-routing.md`。
- relevant_evolution: 当前静态 CSS 已让 `.scenes__title` 避开 editorial 字体规则，但 `.deploy__lead` 仍被该规则选中。

## acceptance
- 国际站步骤区标题与相邻两区块标题使用同一无衬线字体。
- 国内站对应标题保持一致；无须额外变更时注明。
- 生成入口和生成产物一致；聚焦测试、前端门禁通过。

## affected_paths
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/international-home-runtime.tsx`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## required_context
- `site-environment-routing`；前端服务规则。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站边界 | 分别核对国内、国际首页 |
| `frontend/AGENTS.md` | 前端门禁 | 确定验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 相邻测试与生成物 | 定位生成脚本和测试 |
| `frontend/openspec/specs/marketing.md` | 当前营销入口 | 核对首页组件 |
| `frontend/src/lib/public-site-routing.ts` | locale 入口 | 不硬编码站点推断 |

## evidence
- 源码检查：国际首页 `.deploy__lead` 命中 `--font-cover-en`；两处参考标题实际为 `--font-sans`。国内首页 `zh-CN` 不命中该选择器，国内旧组件标题也共用 `lw-font-hyruiyisong`。
- `node --test scripts/international-home-feature-locales.test.mjs`：25/25 通过。
- 聚焦首页 / CTA 测试：90/90 通过；`pnpm typecheck`、`pnpm check`、国内与国际 `pnpm build` 通过。
- 全量 `pnpm test` 遇到其他模块失败与 `agent-create-bot-paths` Node OOM，已中止；未据此宣称全量通过。

## risks
- CSS 缓存可能保留旧样式；递增静态资源版本查询参数。回滚为恢复本次 CSS 与生成脚本改动。

## validation
- 聚焦首页样式测试、前端 typecheck/check/test/build、context change-impact 检查。当前 `package.json` 无 lint 脚本；用 `pnpm check` 执行现有综合静态门禁。

## decisions
- 只移除步骤区标题的 editorial 字体选择器，让其继承首页 `--font-sans`。国内站已一致，不改国内专属样式。

## scan_scope
- `frontend/public/lightvela-intl-home/`、`frontend/scripts/import-international-homepage.mjs`、`frontend/next-site/`、国内旧首页组件。

## scan_output
- 有界 `rg` 和源码片段检查，无额外扫描产物。

## handoff
- 字体修正已通过聚焦测试、typecheck、check 和双站构建；全量测试未通过。未提交、未推送、未发布。
