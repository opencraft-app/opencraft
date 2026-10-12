---
id: task-global-bot-docs-cn-20261011
type: task
scope: 国际站中文 Bot 流程文档与真实截图更新。
triggers: ["global Bot docs Chinese review", "个人 AI 助手文档", "国际站中文创建流程"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-onboarding-panel.tsx
  - frontend/src/content/docs/global/configuration/bots.md
status: active
reviewed_at: 2026-10-11
review_due: 2026-11-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
按 mono2 master 980056ee578afd2e66282ea7ba154200f238e6c6 修正国际站中文创建、换装、切换 Bot 与个人助手文档，并补实际 UI 截图，供用户审阅。

## non_goals
- 不改 ClawHub / Skills.sh 既有来源表述；本次仅提交国际站中文 MR，不做其他语言、不合并或发布。
- 不创建真实 Bot，不保存头像、模型或通道配置，不改变生产资源。
- !5181 未合入 master 的关闭按钮不写成已上线能力。

## requirement_ids / requirement_refs / requirement_excerpt
用户：其他内容根据 mono2 最新代码修正，该配截图的配一下，先做中文，check 后再做多语言。

## interface_refs / data_structure_refs
- agent-onboarding-panel.tsx: form → creating → done；颜色/形状/配饰；cloneOptions 仅已有 Bot 时传入。
- CTL instance/bots.go 与 bots_test.go：blank 继承主模型并初始化基础 Skills；clone 不继承通道、任务和会话。
- docs-sidebar.ts GLOBAL_SLUG_TO_FILE 与 sync-fumadocs-content.mjs 注册保持不变。

## history_context
- current_design_refs: frontend/AGENTS.md、frontend/docs/README.md、源码与相邻测试。
- relevant_evolution: 最新 master 含换装；!5181 尚未合入，当前创建仍为必做弹窗。
- superseded_refs: 旧顶栏页签、复制当前/主 Bot 固定选项、网页对话仅主 Bot 的说明。

## acceptance
- 七篇中文文档一致，网页对话无通道前置；真实创建及管理入口准确。
- 图片来自 lightvela.ai 中文 UI，复用现有 WebP 引用，无账号菜单、凭据或二维码。
- 文档同步、链接图片检查、相关内容门禁和全球构建通过；不修改其他语言源。

## affected_paths
frontend/src/content/docs/global/{02-quickstart.md,create-first-hermes.md,05-configuration.md,configuration/bots.md,configuration/bots-switching.md,configuration/agent-chat.md,use-cases/personal-ai-assistant.md}；对应已引用中文 UI 图片与 last-updated.json。

## required_context
frontend-product-surface / site-environment-routing / service-frontend。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| docs/context/project/services/frontend.md | 服务真源与验证 | 文档源/生成物分离 |
| docs/context/domains/site-environment-routing.md | 国际区域 | 保留 global 范围 |
| frontend/AGENTS.md | 服务门禁、WebP | 图片与检查要求 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接核对 | 运行配置及测试 |
| .agents/skills/product-skills/lv-docs/SKILL.md | 文档任务 | A/B 档、真实截图和同步 |
| .agents/skills/product-skills/lv-docs/assets/templates/international-use-case.md | 场景模板 | 检查表与验证边界 |
| .agents/skills/product-skills/lv-seo-geo/SKILL.md | Use Case 搜索意图 | 真实内链、实体表达 |
| wiki/growth-state/lightvela-docs-content-categories.md | 内容分类状态 | 已注册页面修订，不改变已发布状态 |
| frontend/src/lib/docs/docs-loader.ts | 加载机制 | global 与其他区域隔离 |
| frontend/src/config/docs-sidebar.ts | slug/侧栏 | 现有路由可达 |
| frontend/scripts/sync-fumadocs-content.mjs | 注册与生成 | 不手改生成物 |
| frontend/src/contexts/runtime-config-context.tsx | 多 Bot 默认开关 | 不宣称入口默认隐藏 |
| frontend/src/pages/marketing/agent-onboarding-panel.tsx | 创建/配置 | 当前流程及不变量 |
| frontend/src/pages/marketing/agent-onboarding-mark.ts | 引导开关 | 创建路径启用 |
| frontend/src/pages/marketing/__tests__/agent-onboarding-global.test.tsx | 国际创建邻居 | 区域模板和设置 |
| frontend/src/pages/marketing/__tests__/agent-create-bot-paths.test.tsx | 创建入口邻居 | 空白及复制 |
| ctl/pkg/instance/bots.go、bots_test.go | 继承规则权威 | 系统基础 Skills 与非继承项 |

## evidence
- latest master: 980056ee57（!5186）；!5181 的可关闭创建未合入。
- 已在真实国际站确认头像列、新建 Bot、三步换装、高级创建方式下拉；没有点击创建或保存。
- 有界失败查询 ctl/pkg/logic/bot*、ctl/pkg --glob '*bot*.go' 后，精确扩大到 ctl，定位 ctl/pkg/instance/bots.go。

## risks
真实截图来自线上；若线上与 master 不一致，以源码为流程事实并记录截图差异。不补造首次创建画面。

## validation
文档同步、无死链及图片、仅中文源差异、前端内容检查与全球构建。

## decisions
用户明确要求中文先审阅，覆盖 Skill 的自动多语言同步要求。既有 Skills 来源文本保持原样。

## scan_scope
七篇目标页、其 global 配置邻居、对应 frontend 创建实现和 CTL Bot 继承 contract。

## scan_output
正文与图片真源；验证日志保存在工作区 output。

## handoff
build；完成正文与真实截图后给用户审阅，之后再按用户确认做多语言。

## checkpoint（2026-10-11）
- stage: verify；七篇国际中文正文与七张生产 UI WebP 已更新，中文同步门禁通过（630 文档日期、657 同步产物）。
- 用户明确中文先审；不改语言源、不改既有 Skills 来源、不提交发布。同步器自动生成繁体产物不表示完成多语言审阅。
- 当前等待链接/图片与全球构建；审阅页使用真实截图，不补造首次创建截图。
- restore: output/docs-cn-review-20261011，分支 codex/docs-bot-flow-cn-20261011，基线 980056ee578afd2e66282ea7ba154200f238e6c6。
- next_action: 完成门禁并展示中文审阅页，待用户确认。

## 最终审阅交接（2026-10-11）
- stage: 等待用户中文审阅；不提交、不推送、不发布文档，不开始其他语言源稿。
- latest master 980056ee578afd2e66282ea7ba154200f238e6c6 已重新核对。
- 七篇中文源稿、七张源 WebP 与对应生成 public/docs-images 副本已更新，日期登记及 docs-route-manifest 由脚本同步。
- pnpm docs:sync 通过；74 条链接、15 处图片引用和七篇实际渲染 HTML 内容检查通过；原 ClawHub 段落逐字保留。
- 全球构建与静态后处理通过：1562 HTML、58 条公共路由。因复用依赖软链超出 Turbopack 根目录，本地使用 next build --webpack 验证，未修改 Next 配置；部署仍由正常依赖安装和既有构建流水线负责。
- 审阅入口：工作区 output/lightvela-docs-cn-review-20261011.html（截图嵌入，可离线阅读）。日志位于工作区 output/docs-cn-review-webpack-build.log。
- 自建 frontend/node_modules 依赖软链在构建后移除，未触及原依赖目录；未来继续验证时需重建依赖链接或正常安装。
- next_action: 根据用户中文反馈修改；确认后再本地化其他语言。!5181 的关闭能力尚未合入 master，不写成已上线。

## 图片反馈修订（2026-10-11）
- stage: 中文本地预览复核；用户指出个人助手的创建段落缺图及「开通第一个 Hermes 实例」配图不足。
- 个人助手的创建步骤新增已有 Bot 时的表单截图并明确它不是首次创建画面；开通实例页新增创建表单、可选推荐模板、创建后 Bot 入口三处现有生产 WebP 引用，不新增或合成首次创建截图。
- `pnpm docs:sync` 通过（630 日期登记、657 文档同步）；全球 `next build --webpack` 通过（794 静态页）；审阅生成器校验 7 页、74 条链接、19 处图片引用通过。
- 本地 `127.0.0.1:5185/zh-sg/docs/create-first-hermes/` 实测三张新增图均加载，naturalWidth 分别为 1400、1500、515；中文审阅 HTML 已重新生成。依赖软链已移除。
- next_action: 用户已授权提交已完成的国际站中文 MR；其他语言与国内站适配交给后续任务，不合并、不发布。

## 提交前门禁补记（2026-10-11）
- 最新 `origin/master` 仍为 `980056ee57`，与分支基线一致；`git diff --check`、文档路由/图片审阅生成器、`validate_documentation.py` 和 `check:mono2-agent-console` 通过。
- `pnpm check` 的 i18n、文档日期、同步、MDX 阶段通过；最终 typecheck 报 23 条新诊断，路径指向复用的另一个工作树 `node_modules` 中的 `velachat`，并非本次七篇 Markdown 或截图。当前工作树未安装独立依赖。
- 全量 `pnpm test` 跑出既有首页、管理台等无关失败后中止；文档专项 83 项中 82 项通过，唯一失败为未改动的泰语文档缺摘要（73 篇）。这些门禁限制需在正常依赖环境/后续工作中复核，不将其记为通过。

## 中文 MR 交付与后续任务（2026-10-11）
- 本 MR 只含国际站 `global/` 下七篇中文源稿、七张真实中文 UI WebP 及其 `public/docs-images` 副本、文档同步生成物和本 Task Pack；不将生成的繁体页面视为已完成翻译。
- 其他 AI 继续前先读取 `.agents/skills/product-skills/lv-docs/SKILL.md`，拉取最新 `master`，重新核对创建流程和各区域实际 UI，尤其不要把尚未合入的 !5181 能力描述成生产能力。
- 后续范围：国内站 `frontend/src/content/docs/` 根目录对应主题的中文适配；国际站 `en/`、`id/`、`ms/`、`th/`、`es/`、`ja/`、`ko/` 中实际存在的对应页面翻译；繁体渲染与文案复核。每个区域按真实功能和入口单独核验，不能机械复制国际站中文。
- 后续配图：国内和各国际语种只用对应地区真实 UI 截图，重新检查现有 `*-en.webp` 是否过时。保留正确裁切、WebP 源图和 `public/docs-images` 镜像、正文 alt 与图注；首次创建画面不得拿再次创建截图冒充。
- 既有 ClawHub 文字按用户要求不改。后续工作使用单独分支/MR，先由用户复核文案和图片，再提交。
