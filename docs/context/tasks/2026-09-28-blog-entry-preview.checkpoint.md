---
id: blog-entry-preview-checkpoint-2026-09-28
type: task
scope: 国际站 Blog 本地走查交接状态。
triggers: ["Blog 本地走查 checkpoint", "国际站入口恢复交接", "博客预览续接"]
owner: jasminzhao
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-28-blog-entry-preview.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

# 国际站 Blog 本地走查交接

## stage
四篇文章已完成中英文翻译和统一社群结尾；国际站默认英文、国内站默认中文。国际站正文随简体或繁体中文选择同步切换，其他未翻译语言回退英文。当前排序为 Jasmin Zhao 的 Product 在首位（用户最新指定分类），其后为 Walker Cao 的三篇 Use Cases。

- 首篇分类调整：浏览器卡片与 Product 筛选验证通过；10 项内容和列表测试、check、国际站构建通过。日志 /tmp/jasminzhao-blog-category-*。

- 最新语言切换修复：38 项聚焦测试、check（171 基线、0 新增）、国内与国际构建通过；实际菜单验证同篇英文→简体中文→英文，标题和正文一致。默认双站各四篇及国际简体、繁体各四篇静态产物均通过语言与 metadata 检查。进群方式继续按区域，图片语言不变。下文固定站点正文语言及旧 canonical 记录属于历史状态，以本条为准。日志 /tmp/jasminzhao-blog-language-*。

## verified
- 封面比例后续更新：首篇使用用户新提供的英文 Your Personal AI 封面；所有列表和详情封面使用 16:9 容器与铺满裁剪，首篇靠左保留文字。正文图片比例不变。浏览器已核对新封面和其他卡片，18 项相关测试、check、国际站构建通过；日志 `/tmp/jasminzhao-blog-ratio-{tests,check,build}.log`。
- 最新要求已完成：完整翻译正文、标题、摘要及自然语言提示词；图片和命令标识保留。统一 BlogCommunity 在分享区前提供国际 Discord / WhatsApp 二维码及链接，或国内微信二维码，替换原稿重复入群结尾。
- 试用链接显示文本和 href 去除 from / utm_* / ref / source，首页试用与分享域名跟随站点；SEO 与 sitemap 声明国内 zh-CN 和国际 en-US 的真实文章版本。
- 最终 37 项相关测试通过；pnpm check 通过（171 基线诊断，0 新增）；build:cn 与 build:global 均通过。两个站点各四篇静态产物已检查正文语言、二维码、canonical、hreflang、图片路径及干净试用链接。日志 `/tmp/jasminzhao-blog-regional-*`，结构化产物证据 `/tmp/jasminzhao-blog-{cn,global}-artifact-proof.json`。
- 国际预览 5174 保留；额外国内预览 5175，独立缓存 `.next-blog-cn-preview`，会话 65065。浏览器确认国际英文和双二维码、国内中文和微信二维码。
- 先前的“原稿语言不翻译”决定已被用户的新翻译要求覆盖，以下记录为历史验证。
- 最后补图：组队篇封面已用用户提供的结对编程图片补齐，列表、详情及社交元信息共用 `cover-supplied.webp`；浏览器显示正常，16 项相关测试、check 和国际站构建通过。日志 `/tmp/jasminzhao-blog-cover-{tests,check,build}.log`。
- 后续走查更新：英文发布介绍已排到首位，用户补充的六张原图分别替换封面、首页、创建 Agent、线上交流、Telegram 和 Workbench。16 项相关测试、check 与国际站构建通过；浏览器封面及六个本地图片响应已验证。日志 `/tmp/jasminzhao-blog-image-update-{tests,check,build}.log`。
- 当前分支 `jasminzhao-blog-0928` 已快进至远程 master `7b196ee3c`。
- 国际站 7 种 locale 及默认首页片段恢复产品栏 Blog 链接，共享 Footer 仅 isGlobal 时展示。
- `pnpm check`、`pnpm build:global`、10 项入口聚焦测试通过，文档校验无错误。
- 浏览器实际点击首页 Blog → 列表 → 第一篇文章 → Back 成功，列表封面已显示。
- 本地服务 `http://127.0.0.1:5174`，Blog `http://127.0.0.1:5174/blog/`；开发进程工具会话为 20819。

## unverified
- 全量前端测试有其他失败且停滞，停止本轮测试进程后未宣称全量通过；日志 `/tmp/jasminzhao-blog-all-tests.log`。
- context 全库门禁存在历史任务元信息和中文规则问题，未扩大本需求处理；audit 单测 33 项通过。
- 登录服务不可用，仅公开内容走查已验证；生产发布与缺失封面补充待用户进一步指示。

## discard
- 不继续 TAPD 建单；最新用户指令转为本地运行与入口恢复。
- 初次 context 检查与 build 并发遇到导出目录变动，已在构建完成后重跑。

## restore
- 保留现有 coffee-warmup 文档和 PRD，未提交、推送或发布。
- 本地开发使用独立 `.next-blog-preview` 缓存，并仅在 `.git/info/exclude` 排除。
- 构建会重写自动生成的 next-env.d.ts；构建产生的无关字体二进制变动已恢复。
- `frontend/openspec/specs/blog.md` 与 PRD 已记录国际站恢复范围。

## next_action
用户已授权拉取并合并 master、CR、提交、推送与创建 MR。已快进合并 origin/master eda52dd93，独立 CR 无阻塞发现，PRD 已按最终范围重写；验证已完成，提交当前 77 个任务文件并创建目标 master 的 MR，不合并 MR 或发布。

- 合并后最终证据：frozen install、check（171 基线，0 新增）、双站构建与文章静态产物检查通过。212 项前端测试中 209 通过，3 项已证实为 master 首页 PNG/WebP 基线问题；文档与设计影响检查通过，context-audit 33 项单测通过，全库 context 4 项已有失败写入 MR。日志 /tmp/jasminzhao-blog-mr-*。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮：拉取 master 最新代码、本地运行国际站并放出 Blog 入口。
- PRD：`wiki/prd-docs/2026-09-28-blog-entry-content-experience.md`。

## interface_refs / data_structure_refs
- `frontend/src/lib/region.ts` 的 isGlobal / localizedPath，不变更数据结构。

## history_context
- current_design_refs：`frontend/openspec/specs/blog.md`。
- relevant_evolution：前序双站隐藏入口，本轮只恢复国际站。
- superseded_refs：`wiki/prd-docs/2026-09-28-public-content-cleanup.md` 中的国际站隐藏要求。

## context_receipt
- 继承 `docs/context/tasks/2026-09-28-blog-entry-preview.md` 的实际阅读记录。


## 内容替换实现
- 用户已确认前三篇 Walker Cao、最后一篇 Jasmin Zhao，分类授权自行决定；已采用前三篇 Use Cases，最后一篇 Announcement。
- 活跃清单为四篇；旧七篇源稿归档，不再参与发布。两个相同 slug 使用新稿，其余旧 slug 退出静态路由及索引。
- 原始素材为 3 篇中文、1 篇英文；原文提示词只展示不执行；源图下载清单包含签名 URL，不提交或输出。
- 三篇中文已整理为 32 次图片引用（30 张独立图片）；英文从用户 PDF 提取 6 张图；组队篇独立封面留空。
- 封面完整显示原图，正文图片保持原比例并按需加载；文章 lang 和 metadata 与原稿一致，前缀页面 canonical 收敛到裸路径。

- 最终 8 个测试文件共 55 项通过；pnpm check 通过（171 基线诊断，0 新增），pnpm build:global 通过（608 静态页面）。日志位于 `/tmp/jasminzhao-blog-final-{tests,check,build}.log`。
- 静态产物核对：裸路径仅四篇，全部图片引用可解析，zh-sg 文章原稿语言与 canonical 一致；五个退役 slug 的导出目录、sitemap、llms.txt 均不存在。
- 文档校验与变更设计映射检查通过；context 全库门禁仍为已有任务元信息问题，本任务未产生匹配错误。没有扩大修改历史任务。
- 本地 HTTP 实测：旧 Discord 文章 404，鹈鹕杯与 zh-sg 界面的英文文章 200。
- 浏览器确认四篇清单、公告筛选、中英文详情页、作者与封面显示正常。
