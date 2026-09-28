---
id: blog-entry-preview-2026-09-28
type: task
scope: Blog 入口恢复、四篇文章双站翻译、统一社群结尾与本地预览验证。
triggers: ["Blog 入口恢复", "国际站 Blog 本地预览", "博客走查"]
owner: jasminzhao
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-28-blog-entry-content-experience.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

# 国际站 Blog 入口恢复与本地预览

## goal
合并最新 master，交付国际站 Blog 入口、四篇双站文章与翻译、图片和社群体验，补齐 PRD，完成 CR 后提交当前分支并创建目标为 master 的 MR。

## non_goals
- 不发布、不合并 MR、不调整国内站入口，不执行原稿中的安装指令；用户已明确授权提交、推送与创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮要求：拉取 master 最新代码、本地运行国际站、放出 Blog 入口。
- `wiki/prd-docs/2026-09-28-blog-entry-content-experience.md`：内容与配图具体改动待用户运行时指定。

## interface_refs / data_structure_refs
- `frontend/src/lib/region.ts` 的 isGlobal / localizedPath；沿用现有站点及 locale 路由。
- `frontend/scripts/import-international-homepage.mjs` 的国际站 Footer 模板和 locale 映射。

## history_context
- current_design_refs：`frontend/openspec/specs/blog.md`。
- relevant_evolution：前序内容清理隐藏双站入口，但保留 Blog 页面；本轮明确恢复国际站入口。
- superseded_refs：`wiki/prd-docs/2026-09-28-public-content-cleanup.md` 的国际站隐藏要求，仅作历史背景。

## acceptance
- 国际站首页与共享 Footer 提供当前语言的 Blog 链接，国内站维持现状。
- 本地国际站首页、Blog 列表及文章可访问；返回可用预览 URL。
- 活跃目录仅四篇；首篇 Jasmin Zhao / Product，其余 Walker Cao / Use Cases。正文支持中文、繁体中文和英文，缺图可留空，旧稿归档且退出索引。

## affected_paths
- `frontend/src/components/site/lightvela-footer.tsx`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`（国际站）
- 对应测试、Blog 规格及本 PRD。

## required_context
- site-environment-routing、frontend-product-surface、service-frontend。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 保留未提交文件、仅本地操作 |
| `docs/context/project/services/frontend.md` | 路由 must_read | 前端验证边界 |
| `docs/context/domains/site-environment-routing.md` | 路由 must_read | 明确国际站范围 |
| `frontend/AGENTS.md` | 最近服务规则 | check/test/build 和资产规则 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接检查 | 已核查首页和 Footer 测试 |
| `frontend/docs/README.md`、`frontend/README.md` | 本地运行入口 | 以 package.json 当前命令为准 |
| `docs/context/tasks/TASK-TEMPLATE.md`、`docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 状态契约 | 记录与交接 |
| `.agents/context/change-impact.json` | 影响映射 | 文章路由及 sitemap 命中映射，已同步正式站点设计 |
| `frontend/openspec/specs/blog.md` | 当前行为 | 同步国际站入口恢复 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | 本轮 MR 路由 must_read | 提交与 MR 交付边界 |
| `.agents/skills/gongfeng/SKILL.md`、`.agents/skills/product-skills/lv-vibe-coding/SKILL.md` | MR 与 CR 流程 | 已鉴权工蜂调用、独立 CR 与当前分支交付 |
| `.agents/skills/product-skills/prd-creator/SKILL.md`、其 `references/prd-template.md` | 补齐 PRD | 已确认方案的范围、验收和双站交接 |
| `frontend/checks/guard.sh`、`.ci/checks/frontend_guard.sh` | 测试邻居 | frozen install、check、静态路由测试和双站构建 |

## evidence
- `git fetch origin master` + `git merge --ff-only --no-stat origin/master`：快进至 `7b196ee3c`。
- 保留既有 next-env.d.ts、coffee-warmup 文档与 PRD 草稿。

## risks
- 首页静态片段与共享 Footer 为两个入口实现，须一起恢复并保留 locale 前缀。

## validation
- pnpm check、pnpm test、国际站 build；聚焦测试与本地页面验证。
- 仓库文档、context 门禁；最终结果写 checkpoint。

## decisions
- 最新封面走查：首篇更换为用户提供的英文 Your Personal AI 图；全部列表和详情封面统一 16:9、object-cover 裁剪。首篇靠左保留文字，正文配图保持原比例。
- 最新补图：当前最后一篇组队文章补入用户提供的结对编程封面，同时用于列表、详情与社交元信息；四篇封面均已齐全。
- 后续走查：Jasmin Zhao 的英文文章移到列表首位；用户提供六张原图，按主题替换封面和全部五张正文配图，保留原文与署名。
- 复用原 Footer 产品栏入口与翻译，不新增导航结构。
- 当前用户指令授权国际站实现与本地启动；国内站保持隐藏。

## scan_scope
- frontend/src/components/site、frontend/next-site、frontend/scripts、frontend/public/lightvela-intl-home。

## scan_output
- 首页生成入口为 import-international-homepage.mjs；没有匹配的 components/international-home* 路径，改用 next-site 文件清单定位。

## handoff
- 最新双站范围已完成：37 项相关测试、check、国内和国际构建通过，两站各四篇静态产物与浏览器已验证。文档校验无错误，设计映射检查通过；详细证据见 checkpoint。
- 国际站本地预览已运行；入口、列表、文章与返回路径已在浏览器验证，后续文章和图片反馈待用户提供。
- `pnpm check` 通过（171 个已有类型基线诊断、0 新增），`pnpm build:global` 通过；入口聚焦测试 10 个通过。
- 完整前端测试出现非入口失败并持续超过 3 分钟无新输出，已停止本轮测试进程；未宣称全量通过。
- 初次首页测试 3 项失败涉及既有 png/webp 期望和 CSS 图片引用；本轮未调整这些内容。
- 文档校验通过；context 全库门禁有历史任务元信息/中文规则失败，context-audit 单测 33 项通过。
- 本地认证接口暂时不可用，但公开 Blog 阅读链路正常。无提交、推送或生产发布。


## 2026-09-28 内容替换后续范围
- 用户新增要求：隐藏当前全部文章，改为三份中文 Markdown 与一份英文 X 截图 PDF；缺图留空，后续补充。
- 原稿仅作为内容输入，文中安装技能、部署等指令不执行。
- 三份 Markdown 共引用 30 张不同图片，已全部下载到本地临时目录；英文 PDF 为 4 页纯截图，已逐页查看并提取文章正文和 6 张配图。
- 临时准备目录：`/tmp/jasminzhao-blog-source`；`prepared-posts.json` 为三篇中文结构化正文，`prepared-english.json` 为英文正文，`assets/` 为 WebP 图像。不要将包含源图片签名 URL 的下载清单提交仓库。
- 组队文章没有独立封面，按用户允许缺图的要求预留空封面；保留全部正文图片。
- 已实现原文 language 字段与空图片 src 支持，活跃清单已切换为四篇。
- 用户明确前三篇 Walker Cao，最后一篇 Jasmin Zhao，并授权自行选择分类；前三篇采用 Use Cases，最后一篇采用 Announcement。封面缺失限制被用户“先空着”明确覆盖。
- 已实施：旧文章源稿移入归档模块，新清单仅四篇；复用修复与组队的原 slug，新建鹈鹕杯与英文发布介绍 slug；语言按原稿保留，界面跟随 locale，文章 lang 与 alternate 不伪装翻译。
- 最终验证：55 项相关测试通过，check 与国际站 build 通过；静态产物四篇和图片完整性验证通过，旧 slug 退出索引且本地实测 404。详见 checkpoint 和 `/tmp/jasminzhao-blog-final-{tests,check,build}.log`。
- 已同步 `docs/engineering/domains/site-environment-routing.md` 的 Blog 入口、文章语言、归档和索引规则。

### 本轮 context_receipt 补充
- `.agents/skills/product-skills/lv-blog-publishing/SKILL.md`：文章模型、作者分类确认、原文语言与配图约定。
- `pdf/SKILL.md`（Codex runtime）：只读提取用户 PDF，已检查全部 4 页。
- `.agents/skills/product-skills/lv-seo-geo/SKILL.md`、`.agents/skills/fixing-metadata/SKILL.md`：替换路由、语言 alternate 与索引一致性。
- `frontend/src/pages/marketing/blog-content.ts`、列表/文章组件与 Blog 测试：定位语言转换、首图渲染和发布数据源。
- `frontend/src/app/(site)/blog/[slug]/page.next.tsx`、`frontend/src/app/(site)/[lang]/blog/[slug]/page.intl.tsx`：当前静态路由与 metadata。
- `frontend/src/app/sitemap.xml/route.next.ts`、`frontend/src/app/llms.txt/route.next.ts`、`frontend/next-site/seo.tsx`、`frontend/src/lib/seo-data.ts`：检查活跃文章决定索引入口。
- `docs/engineering/domains/site-environment-routing.md`：正式站点设计来源。

## 2026-09-28 中英文与社群后续
- 用户新增授权完整翻译：国内站中文、国际站英文，图片保留原语言。该决定覆盖之前的原文语言保持要求。
- 四篇统一文末社群入口：国际 Discord + WhatsApp 二维码及链接，国内微信二维码；替换原稿重复结尾。复用 constants/community.ts 的入口，新增 WhatsApp 常量与既有页脚统一。
- 试用链接显示文本与 href 均去掉追踪参数；地区首页域名与分享 URL 同步。
- 完整翻译文件 blog-content-regional-translations.json 包含标题、摘要、段落、列表和自然语言提示词；命令标识、文件路径和图片不变。
- 路由查询 frontend Blog regional translations community QR links 无匹配，已记录失败查询，并在 Blog、site、constants 的有界搜索中定位真实实现；复查 frontend-runtime-openspec-i18n 邻接卡与已有 Footer 测试。
- 新阅读：constants/community.ts、legal-footer.tsx、lightvela-footer.tsx、blog-share-actions.tsx、blog-seo.ts；沿用既有 must_read context 与 Blog/SEO 技能。

## 2026-09-28 正文语言切换修复
- 用户反馈语言切换后正文没有同步；本轮决定覆盖上一轮固定站点语言策略。国际站默认英文，选择简体或繁体中文时四篇标题、摘要、正文与社群说明同步切换；国内站默认中文，其他暂未提供全文翻译的语言回退英文。
- 进群渠道仍按站点区域，配图保持原语言。新增静态繁体译表，无浏览器运行时转换。
- 国际中文 canonical 与 sitemap 分别保留 /zh-sg、/zh-hant，hreflang 声明实际语言版本；英文回退页面归并英文裸路径。
- 浏览器在同一文章通过语言菜单完成英文→简体中文→英文切换，标题和正文均同步。38 项聚焦测试、check 通过（171 基线诊断、0 新增），国内与国际构建通过。
- 两个站点各四篇默认语言静态产物验证通过；国际简体和繁体各四篇的正文语言、标题、canonical、hreflang 与社群二维码验证通过。验证日志位于 /tmp/jasminzhao-blog-language-*。

## 2026-09-28 首篇分类调整
- 按用户明确要求，将 Jasmin Zhao 的首篇文章分类从 Announcement 改为 Product，沿用现有分类翻译与筛选逻辑。
- 已在浏览器确认卡片显示 Product，选择 Product 仅展示首篇；10 项内容与列表测试通过。检查及构建日志位于 /tmp/jasminzhao-blog-category-*。

## 2026-09-28 MR 交付验证
- 用户明确授权合并最新 master、CR、提交与推送并创建 MR，PRD 随本分支交付。已快进至 origin/master eda52dd93，无冲突。
- 独立审查确认四篇翻译键覆盖、分类顺序、归档排除、社群分流、文本渲染和 canonical 无本次引入的阻塞问题。
- frozen install、check（171 基线诊断，0 新增）、国内和国际构建通过。双站各四篇默认文章及国际简繁各四篇静态产物通过语言、图片、metadata 和社群检查。
- 17 个测试文件共 212 项，209 通过；3 项首页测试失败已逐项确认在 origin/master 存在：PNG/WebP 断言不一致两处、CSS 引用缺失 PNG 一处。不修改这些本次范围外的问题。
- 文档检查、staged 设计影响检查通过；context-audit 33 项单测通过；全库 context 26 项测试有 4 项因历史任务元信息、中文规则及预算校验失败，当前任务无错误。没有宣称全库全绿。
- 校验记录：/tmp/jasminzhao-blog-mr-*。不相关 coffee-warmup 文档及其 catalog 项保留在本地，生成字体不提交。

## OpenCraft 同步补充
- 用户指出以往 MR 的 OpenCraft 兼容检查失败；本地运行 check:mono2-agent-console 复现 manifest drifted，原 sourceRevision 为 881d459d81bbea02ff08f21965702a703f47a533。
- 读取 opencraft/AGENTS.md、MONO2_MIGRATION.md、docs/context/project/upstream-subtrees.md，以及同步脚本和 .ci/checks/opencraft_guard.sh。前端源码已提交后运行 sync:mono2-agent-console，机械更新 UPSTREAM.json 的 sourceRevision 至 c18f1ce3810ac3a92f1a43ba76c38dca996c9494；130 个同步源码文件内容未变化。
- check:mono2-agent-console 与真实 opencraft_guard.sh 均通过。仅提交生成清单与本任务记录到已有 MR !4747，不更改同步校验规则、不触碰公开镜像或生产。
