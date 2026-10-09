---
id: task-international-malay-20261008
type: task
scope: 国际站马来语界面、文档与嵌入式工作台本地化。
triggers: ["Malay", "马来语", "ms-MY"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["frontend/src/i18n/locales.json", "opencraft/apps/workbench-web/src/i18n/catalogs.ts"]
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.1.0
precedence: task
derived: false
---

# 国际站马来语版本

## goal
按用户要求为国际站增加 ms-MY，包括公开网站、产品界面与产品文档。

## non_goals
- 国内站功能变更、合并 master、生产发布。

## requirement_refs
- 本次用户请求：整个国际站支持马来语，包括产品界面、产品文档。

## requirement_excerpt
“为国际站 lightvela，增加一个马来语的版本，整个国际站都支持，包括产品界面、产品文档”；“记得同步一下 master 最新代码”。

## requirement_ids
- user-request-international-malay

## superseded_refs
- 无。

## interface_refs / data_structure_refs
- frontend/src/i18n/locales.json；LocaleCode / UrlLang / I18nDictKey。
- frontend/scripts/sync-fumadocs-content.mjs；国际站独立文档源与生成路由。

## history_context
- current_design_refs: docs/engineering/domains/site-environment-routing.md
- relevant_evolution: 已有语言注册表及多语言首页静态片段。

## acceptance
- ms-MY 字典无缺失、插值不变；国际站 /ms-my/ 与文档、搜索、SEO可用；国内站不生成马来语页面。
- frontend check/test/build 与仓库 context 门禁。

## affected_paths
- frontend/src/i18n、frontend/next-site、frontend/scripts、frontend/src/content/docs/ms、相关公开页面、opencraft 工作台语言目录。

## required_context
- site-environment-routing

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 仓库规则 | 验证与发布边界 |
| frontend/AGENTS.md | 前端规则 | 类型与测试门禁 |
| docs/context/domains/site-environment-routing.md | 路由结果 | 双站隔离 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 语言邻居 | 生成与测试入口 |
| docs/engineering/domains/site-environment-routing.md | 正式设计 | 同步语言发布设计 |
| .agents/skills/product-skills/lv-docs/SKILL.md | 文档翻译 | 国际站独立源与同步 |
| frontend/openspec/config.yaml | 现有约束 | 翻译流程 |

## decisions
- code ms-MY，url ms-my，显示名 Bahasa Melayu。
- 使用国际站英文内容底稿，保留命令、链接、插值与产品名。

## scan_scope
- frontend 语言相关源码、脚本与文档。

## evidence / validation（第一轮，基线 86febc63a8）
- `pnpm check` 通过：ms-MY 3,052/3,052、0 错误、0 告警；TypeScript 166 current / 171 baseline / 0 new / 5 resolved。基线仅重映射既有文件两处诊断位置，未新增预算。
- 语言、法律页、博客、搜索、SEO、sitemap、SDK 与语言切换聚焦测试 252/252 通过；后续改动聚焦复验 20/20 通过；SDK 并发切换及菜单回归 11/11 通过。
- OpenCraft `check:i18n` 检查 221 条工作台消息的 ICU 与参数通过，`test:i18n` 10/10 通过；嵌入式目录随宿主语言切换测试通过。
- 73 份文档源与英文源的代码块、行内代码和链接目标逐项相等；公开马来语文档清单与英文清单同为 69 条路由（包括目录首页）。
- 国际站构建通过：707 静态页面任务、1,390 HTML 产物、50 条公开路由 SEO 检查。马来语搜索索引未发现其他语言 URL。
- 浏览器状态矩阵桌面/手机 6/6 通过：首页、手机菜单、文档、搜索并打开结果、保持文档的语言切换、博客社区区块。报告 `/tmp/lightvela-ms-validation/report.html`。
- 文档分类验证、正式设计影响检查通过；context-audit 测试 33/33 通过。
- 首轮全量 Vitest 310 文件 / 4,292 用例通过，另有 39 文件 / 59 用例失败，并出现 AgentSettings worker 挂起。该轮包含未补齐资源造成的失败和生成目录并发冲突；本次语言相关失败已由独立聚焦复验覆盖，其余未宣称修复或全部复验。
- Context 全库校验与测试仍因历史 Task Pack 缺字段失败；本任务的 Task Pack 不在最终错误清单。

## risks / remaining_gate
- `check:mono2-agent-console` 报告生成副本缺少新增马来语资源。按 frontend/AGENTS.md，须先提交真源，再运行同步脚本并独立提交生成副本；用户已追加授权“提交 mr”；真源提交 `49a5790e98` 后同步生成副本，`check:mono2-agent-console` 已通过（133 文件），未手改生成副本。
- 生产发布、真实账号和付费模型调用尚未执行。

## handoff
- 当前实现位于 `/data/mono2-malay-refine`，分支 `codex/lightvela-malay-refine`，基于本轮最新 fetch 的 master `6e2b77732f`；源码与页面可供审阅。
- 原 `/data/mono2` 用户已有未提交改动保留；此前源码未提交、推送或发布；本轮已获用户提交及创建 MR 授权，生产发布不在授权范围。
- 临时翻译脚本、缓存、请求参数均位于 `/tmp`，不属于提交产物。

## master_sync
- 用户明确要求同步最新 master；fetch 得到 86febc63a8。
- 原工作区 /data/mono2 落后 1,960 提交并含用户未提交修改，快进被 Git 拒绝。
- 在 /data/mono2-malay 基于 origin/master 的独立 worktree 实施，三方迁移时保留新版功能、图片格式与文案。
- 最新主界面、SDK 与文档翻译已重新抽取；旧分支测试证据不能证明新基线。

## refinement / latest_master
- 用户追加“同步一下 master 最新代码，再做一轮优化”；再次 fetch 得到 `6e2b77732f`，三方迁移到独立 worktree，未提交、未改原用户工作区。
- 保留 master 新增的积分隔离与失败反馈、Bot 侧栏修复、六行消息队列与失败删除修复。
- 公共翻译字典由 2,624 条 / 649,850 字节精简到 1,384 条 / 377,016 字节（减少约 42%），只收录实际英文文案；补齐四个共享技能分类、场景提示连接短句与选项标签。
- 结构化翻译保留内部标识、字段绑定和链接，读取字典自身键，修复原型属性名称被误当译文的问题。
- 文档 UI 使用完整 `Translations` 类型检查，升级 Fumadocs 时缺失翻译将产生类型错误；开源许可证标题按实际 `Terms of the …:` 格式翻译。
- 复查发现旧马来语概览测试的三条预期与实际独立翻译不一致，已更新并增加马来语概览无中文残留断言。
- 新基线第一组聚焦 21 文件 / 254 用例通过；补充场景字段绑定与概览组件测试 2 文件 / 48 用例通过。
- OpenCraft i18n 检查 221 条通过，语言运行时 10/10、嵌入式语言 1/1 通过。
- 73 份文档的代码块、行内代码、链接目标保持英文源一致；新基线首次国际站构建通过（707 静态任务、1,390 HTML、50 条 SEO 检查），桌面/手机浏览器 6/6 通过。
- 最新浏览器报告 `/tmp/lightvela-ms-refine-validation/report.html`，预览端口 5181。

- 文档清单的旧测试缺少 ms-my，已同步预期，并验证它与英文的 69 条路由相同、国内站无对应生成参数。文档 parity 45/45 通过。
- 仓库文档分类和正式设计影响检查通过，context-audit 测试 33/33；全库 context 测试仍有 4 个历史失败。

- 全量 `pnpm run test --maxWorkers=4` 在 240 秒超时退出（124），存在未完成 worker 和若干失败，未宣称全量通过。复验定位的其他失败包括未改动的 Slack PNG 测试、国内计费文档旧段落断言、营销路由旧清单；完整日志 `/tmp/lightvela-ms-refine-fulltest.log`。

- 最终 `pnpm check` 通过：ms-MY 3,052/3,052、0 错误、0 告警；TS 166 current / 171 baseline / 0 new / 5 resolved。最终国际站构建再次通过；构建 JS 包含本轮新补齐的提示连接短句，搜索索引的 URL 全部位于 /ms-my/docs。

- 最终汇总回归 23 文件 / 340 用例通过，最终浏览器 6/6 通过；搜索以马来语关键词 kredit 验证后，再打开马来语结果并检查语言切换。报告已更新为本轮分支和 master 基线。

## checkpoint
### stage
最新 master 同步与优化已实现，最终 check、国际站构建、汇总回归与浏览器复验已通过。全量测试保留未通过状态；生成副本门禁已在授权提交及同步后通过。
### verified
- 工作区 HEAD 为 6e2b77732f；原用户工作区保留；没有提交、推送或发布。
- 国际站马来语独立资源、文档及浏览器 6/6；聚焦测试及 SDK/嵌入式语言验证见上。
### unverified
- 全量测试未通过；真实账号、付费模型与生产发布未验证。
### discard
- /data/mono2 和 /data/mono2-malay 中旧版本、端口 5179/5180 的预览不能证明本轮最终源码。
### restore
- /data/mono2-malay-refine，分支 codex/lightvela-malay-refine；本轮日志均为 /tmp/lightvela-ms-refine-*。
### next_action
- 用户已授权提交 MR；提交真源、同步并复验生成副本、独立提交副本后推送并创建 MR。

## next_action
- 独立提交已复验的生成副本，推送 codex/lightvela-malay-refine 并创建目标 master 的 MR；生产发布未执行。

## MR submission
- 用户明确授权“提交 mr”，包含本次源码/生成副本提交、分支推送与创建 MR，不包含合并或发布。
- 真源提交 49a5790e98；随后同步的 UPSTREAM.sourceRevision 指向该提交。
- 同步及只读漂移复验通过；OpenCraft 两个受影响 workspace 类型检查和 build:web 通过，221 条语言校验、10 项运行时与 1 项嵌入式语言测试复验通过。
- 此前前端 check/build、340 项聚焦测试、6 组浏览器验收结果沿用；前端源码未在提交阶段改动。
