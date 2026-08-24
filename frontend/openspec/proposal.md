# 国际站西语端到端上线 Proposal

**状态：** Task 1–8 已完成；双区域构建、浏览器验收与独立只读复审全部通过，等待提交审批。

**规模：** L。需求跨国际站公开页、路由、i18n、文档、SEO、字体和控制台多个业务模块，并包含灰度开放与双区域回归门禁。

**发布区域：** 仅国际站 `lightvela.ai`。国内站 `lightvela.com` 必须保持用户可见行为零变化。

## 背景

`jasminzhao-821-language` 已建立 locale 注册表、三语种字典骨架和翻译工具链，但 `es`、`ja-JP`、`ko-KR` 仍全部隐藏。合并最新 `master` 后，中文基准已从 2325 条变化为 2403 条，三份新字典各缺 85 个当前 key、残留 7 个旧 key；新校验器还暴露了既有占位符不一致。

本次只完成西语交付。日语和韩语保留注册但继续隐藏，避免扩大翻译、字体和内容范围。

## 目标

1. 在国际站开放 `/es`，使用户可从语言切换器进入并在刷新、站内跳转和文档跳转后保持西语。
2. 补齐国际站自有 UI 的西语字典，并让字典完整性、占位符、HTML 标签和换行结构通过构建门禁。
3. 为公开页、文档导航与 metadata、SEO、sitemap、canonical、hreflang、`html lang` 和 Open Graph locale 提供一致的西语输出。
4. 为西语扩展字符提供可靠字体回退，避免 `ñ/Ñ/¿/¡` 等字符显示为缺字方块。
5. 以编译期区域分支和负向测试证明国内站没有新增西语入口、路由或用户可见文案。

## 范围

### 本次包含

- 国际站 locale 注册表中的 `es` 正式启用；URL 前缀固定为 `/es`。
- 国际站语言切换器、初始 locale 解析、`localStorage('lw-locale')`、公开页与控制台站内跳转。
- 当前中文基准全部 2403 条国际站自有 UI 文案的西语字典对齐与翻译。
- 国际站公开页导航、页头、页脚、状态文案和控制台自有模块的西语覆盖。
- 文档侧栏分组、页面 title/description、搜索注册、manifest 与路由 metadata 的西语覆盖；正文继续回退英文。
- 公开页与文档页的 title、description、canonical、Open Graph、hreflang、`html lang` 和 sitemap。
- 西语字体回退与构建期字符覆盖检查。
- 国际站定向测试、完整构建和浏览器 smoke；国内站负向测试与构建回归。

### 本次不包含

- 国内站任何西语入口、locale 切换或内容变化。
- `ja-JP`、`ko-KR` 的翻译或开放。
- 三语种文档正文全量翻译；西语正文继续使用英文 fallback。
- 法务正文的西语翻译。
- `@tencent/tea-sdk-lightclaw` 内嵌区域的西语语言包；该区域允许沿用英文 fallback。
- Models 模块整体本地化、账号级语言同步、首次访问自动语言识别和控制台免刷新切换。
- 新后端接口、数据迁移或第三方翻译服务依赖。

## 方案比较

### 方案 A：注册表驱动，全部验证后统一开放（采用）

- 先同步字典基线与门禁，再补路由、切换器、SEO、文档和字体，最后翻译全量字典并打开开关。
- 优点：开发期间西语始终隐藏；所有链路在开放前一起验收，回滚只需关闭注册表入口。
- 代价：最后开放前没有用户可见的中间交付。

### 方案 B：翻译优先

- 先完成字典，再补静态站和路由。
- 优点：翻译进度直观。
- 缺点：`master` 新增文案会持续造成字典漂移，结构问题发现较晚。

### 方案 C：公开站与控制台分阶段开放

- 先开放营销页，再补控制台。
- 优点：可以较早发布公开页。
- 缺点：产生明显语言断层，不符合本次端到端完成口径。

## 主要设计

1. `locales.json` 继续作为 Node/TypeScript 共享数据真源；`locales.config.ts` 保留联合类型和穷举保护。
2. `es` 在实现期间保持 `switcherVisible: false`、`translationRequired: false`；字典、路由、Docs、SEO 与字体门禁通过后已一次性切为 `true`，日语和韩语保持 `false`。
3. 国际站语言切换器改为从注册表生成；国内站继续使用原有区域分支，不消费西语可见项。
4. 西语字典先与当前中文基准做 key 集合同步，再使用 `i18n-apply.mjs` 分批写入，禁止直接对 hash key 盲改；每批运行结构校验。
5. 文档不复制英文正文。西语 locale 使用既有 fallback source，只新增导航、分组、title/description、搜索和 metadata 所需配置。
6. SEO 输出必须保证 title、description、canonical 与 `og:url` 一致，且只为真实存在的 `/es` 页面输出 alternate。
7. 字体按西语 locale 使用拉丁系统字体回退，并区分“源字体无字形”和“subset 漏采集”两类构建错误。
8. 所有共享表改动都保留 `Record<Locale, T>` 穷举；禁止用三元 fallback 或 `startsWith` 猜测掩盖漏配。

## 依赖与风险

- 翻译质量需要统一采用自然的拉美西语表达；产品名、渠道名、模型名和命令保持原名。
- SDK 内嵌区域只有中英文包，本次明确接受英文 fallback。
- 文档正文回退英文必须在切换器与页面中可预期，不得错误回退中文。
- 现有 master 的 `{{discount}}` / `{{percent}}` 占位符不一致必须在本需求门禁中修正，否则 `pnpm check` 无法通过。
- 现有 `openspec/plan.md` 含其他历史未勾选项；本需求计划将置于文件顶部并明确为当前 active change，不删除历史记录。

## 用户验收标准

1. 国际站语言切换器显示 `Español`，选择后进入 `/es`，刷新和站内跳转后保持西语。
2. 国内站不显示西语选项，既有中文行为与构建产物无本需求引入的用户可见变化。
3. `es.json` 与当前中文基准 key 集完全一致，国际站自有 UI 无大段中文或英文残留；SDK 区域英文 fallback 除外。
4. `/es` 公开页和 `/es/docs/...` 可访问；文档导航与 metadata 为西语，正文稳定回退英文。
5. 西语页面的 title、description、canonical、Open Graph、hreflang、`html lang` 和 sitemap 相互一致。
6. 标题与正文中的 `ñ/Ñ/á/é/í/ó/ú/ü/¿/¡` 无缺字方块。
7. locale、字典、公开站、文档、SEO、字体和区域隔离测试通过。
8. `pnpm check`、分别以 `NEXT_PUBLIC_REGION=global VITE_REGION=global` 与 `NEXT_PUBLIC_REGION=cn VITE_REGION=cn` 执行的 `pnpm build`，以及 `git diff --check` 通过。
