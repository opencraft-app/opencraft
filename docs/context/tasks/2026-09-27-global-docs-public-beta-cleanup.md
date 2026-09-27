---
id: global-docs-public-beta-cleanup-2026-09-27
type: task
scope: 国际站文档中过时的整站公测说明清理。
triggers: ["global docs", "国际站文档", "公测说明"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/content/docs/
  - frontend/scripts/sync-fumadocs-content.mjs
status: active
reviewed_at: 2026-09-27
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

## goal
移除国际站已发布文档中把 LightVela 整站描述为公测或内测过渡期的说法，并对齐对应页面摘要与 SEO 描述。

## non_goals
- 不修改国内站中文文档与套餐权益实现。
- 不删除仍由界面标记 Beta 的单项功能说明或第三方产品比较事实。
- 不合并 MR、不发布生产站。

## requirement_ids / requirement_refs / requirement_excerpt
- GLOBAL-DOCS-PUBLIC-BETA：用户在国内站清理后要求“国际站文档里面关于公测期的描述也去掉了吧？”。
- 上一轮国内站 MR !4683 已合并；本轮从最新 `master` 独立提交。

## interface_refs / data_structure_refs
- `frontend/src/content/docs/{global,en,id,es,ja,ko}/` 是国际站语言源；`zh-hant` 从 `global` 生成。
- `frontend/scripts/sync-fumadocs-content.mjs` 和 `frontend/src/lib/seo-data.ts` 提供文档描述。
- `frontend/src/content/docs/last-updated.json` 与 `frontend/next-site/docs-route-manifest.ts` 提供内容日期。
- 保留 `announcements/public-beta` slug 与注册入口，兼容已有链接。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md` 产品文档区域。
- relevant_evolution: 公测转段与内测延期的旧说明散落在多语言概览、开通、套餐、公告、联系页及 metadata。
- superseded_refs: 2026 年 8 月公测安排仅供历史追溯，不作为当前使用指南。

## acceptance
- 国际站六种语言源与生成的繁体中文页面不再展示整站公测阶段说明或过期转段日期。
- 功能级 Beta 与第三方比较内容保持各自事实；旧公告 URL 可访问。
- 文档同步、日期、语言 parity、前端检查、国际站构建及 context 门禁完成，远端 MR 状态可核对。

## affected_paths
- `frontend/src/content/docs/{global,en,id,es,ja,ko}/` 中相关页面及 `last-updated.json`。
- `frontend/scripts/sync-fumadocs-content.mjs`、`frontend/src/lib/seo-data.ts`、`frontend/src/app/llms.txt/route.next.ts` 注释。
- `docs/engineering/domains/site-environment-routing.md` 与本 Task Pack。

## required_context
- 路由 `remove outdated public beta statements from international LightVela documentation across all published locales` 未匹配 Pack；随后对国际站语言源进行了有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@HEAD` | 服务级规则 | 确认区域、检查和构建门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 前端邻接卡 | 检查语言生成链与测试邻居 |
| `frontend/scripts/international-docs-parity.test.ts@HEAD` | 相邻测试 | 保持语言路由和链接结构一致 |
| `docs/engineering/domains/site-environment-routing.md@HEAD` | 正式设计 | 国内与国际文档隔离 |

## evidence
- 有界扫描命中六种语言的概览、快速开始、首个 Hermes、适用人群、联系、公告，以及印尼语套餐页和 metadata。
- DeepSeek Harness、工作台仍由产品界面标注 Beta；Today.AI 比较页描述的是第三方状态。
- `pnpm docs:sync` 同步 549 篇，日期清单 477 篇通过；六种国际站源及生成的 `zh-hant` 对应内容不再包含整站公测口径。
- `pnpm check` 新增 TypeScript 诊断 0；聚焦语言 parity、日期和 SEO 测试 164 项通过；`pnpm build:global` 生成 664 个静态页面并通过 SEO 检查。
- 文档 validator 错误 0、断链 0；context catalog 仍有仓库既有错误，本次 Task Pack 无新增错误。
- 本轮独立 MR !4687 已创建，目标分支为 `master`；远端最终状态以 MR 实时结果为准。

## risks
- 首购活动与 AI 套餐可售状态会变化；当前文案指向订阅页，不从旧公测公告推断权益。
- 旧公告 slug 含 `public-beta`，保留兼容链接，页面正文和描述清理旧阶段口径。

## validation
- `pnpm docs:sync`、国际站 parity/日期/SEO 聚焦测试、`pnpm check`、`pnpm build:global`、文档 validator、staged change-impact。

## decisions
- 清理整站公测说明和已结束的内测延期承诺，保留套餐资源信息与中性新用户优惠说明。
- 暂不调整单项功能 Beta 和第三方比较页的阶段描述。

## scan_scope
- 六种国际站语言源、文档 metadata 及对应生成链；国内站源排除。

## scan_output
- 路径与行号清单及 `git diff`；不内联全量搜索结果。

## handoff
- 本地验证完成，本轮变更见 MR !4687；生产发布不在本轮范围。
