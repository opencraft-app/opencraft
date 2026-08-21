# 国际站 Locale 注册表收敛与新增西语（拉美）、日语、韩语

## 基本信息
- 当前产品：LightVela（国际站 lightvela.ai）
- 需求单状态：草稿
- 创建人：jasminzhao
- 创建日期 / 最后更新时间：2026-08-21 / 2026-08-21
- 需求类型：国际化与地域拓展 + 多语言扩展机制治理
- 发布范围：国际站 only
- 优先级：P0
- 关联 PRD：`wiki/prd-docs/2026-08-18-intl-bahasa-indonesia-locale.md`（本需求的直接前置，`id-ID` 的落地经验与遗留问题由本需求承接）
- 关联分支：`jasminzhao-821-language`

## 需求背景

### 为什么要做
LightVela 国际站已支持 4 个语言版本（`en-US`、`zh-CN`/`zh-SG`、`zh-Hant`、`id-ID`）。业务侧计划继续扩展可使用国家与地区，本次需要新增面向**拉美市场的西班牙语**、**日语**和**韩语**三个语言版本。

但当前多语言体系是「随语种逐次追加」演进出来的，**新增一门语言需要在 8 个文件中手工修改 45 处（其中 27 处为机制性硬编码，18 处为 SEO 文案条目）**，且其中大部分漏改**不会在编译期或 CI 中暴露**，只会静默降级（回退英文/简体、或字体缺字）。本次一次性新增 3 个语种，若沿用现状，手工改动量将放大到约 135 处，回归风险不可控。

### 现状扫描结论（代码事实）

新增一门语言需要改动的位置：

| # | 文件 | 改动处数 | 漏改是否会被发现 |
|---|---|---|---|
| 1 | `frontend/src/lib/public-site-routing.ts` | 8（3 个类型联合 + 4 张映射表 + `matchPublicLangPrefix` 正则） | 部分。`Record<PublicSiteLocaleCode, …>` 会报错，正则不会 |
| 2 | `frontend/src/components/site/language-switcher.tsx` | 7（`I18nLocale` 类型、`*_OPTION` 常量、`currentOption`/`dropdownOptionLabel`/`i18nLocaleForPublicLocale`/`intlSiteUrlForLocale` 四条三元链、`options` 数组） | **否**，三元链带 fallback，静默回退 |
| 3 | `frontend/scripts/i18n-extract.mjs` | 5（字典路径、字典构造、统计、写入、提示；需整段复制 `id-ID` 逻辑） | **否**，纯 JS 无类型 |
| 4 | `frontend/src/i18n/index.ts` | 3（`SUPPORTED_LOCALES`、`import`、`resources`） | 部分 |
| 5 | `frontend/src/lib/region.ts` | 2（`readLocaleFromPath` 返回类型联合、`localizedPath` 三元链） | **否**，三元链带 fallback |
| 6 | `frontend/next-site/source.ts` | 1（`docsI18n.languages`） | **否** |
| 7 | `frontend/scripts/subset-fonts.mjs` | 1（`textInputs` 字符采集源） | **否**，字体缺字属运行时视觉问题 |
| 8 | `frontend/src/app/(site)/[lang]/**/page.next.tsx`（9 个 SEO 页面） | **18**（每页 `TITLE_BY_LOCALE` + `DESCRIPTION_BY_LOCALE` 两张 `Record` 表） | 会。`Record<PublicSiteLocale, string>` 强制穷举 |

合计 **8 个文件（含 9 个页面文件）/ 45 处手工改动**，其中：

- **27 处属机制性硬编码**（第 1-7 项），其中 5 个文件的漏改**完全不会被编译或 CI 发现**，只会静默降级为回退语言或字体缺字。这是本次重构要消除的核心风险。
- **18 处属 SEO 文案条目**（第 8 项），受 `Record` 类型保护不会静默失败，但每新增一个语种需实打实撰写 18 条 title/description。本次 3 语种即 54 条 SEO 文案。

按 3 个语种计算，沿用现状的手工改动量约 **135 处**。

已确认的两处既有缺陷：

1. **`subset-fonts.mjs` 漏了 `id-ID.json`**（`frontend/scripts/subset-fonts.mjs:11-19`）。上次新增印尼语时漏改此处，因印尼语使用纯 ASCII 拉丁字母而未暴露。同时 `preservedText`（同文件 21-26 行）仅包含基本 ASCII 与中文标点，**不含 `ñ á é í ó ú ü ¿ ¡`**。本次西语会直接触发标题字体缺字，日语假名与韩语谚文同理。
2. **存在两套并行的国际化机制**，第二套是主要成本来源：

| 机制 | 载体 | 现状规模 | 新增 1 语种成本 |
|---|---|---|---|
| ① hash 字典 | `frontend/src/i18n/generated/*.json`，业务侧写 `t("中文")` | 2323 条/语种，4 语种全覆盖无缺失 | 翻译 2323 条 |
| ② **按语种复制的 TS 数据文件** | `curated-skill-overviews.{zh,id}.ts`、`agent-buddy-soul-test-data.{en,id}.ts` | 约 1800 行/语种 | **复制并翻译约 1800 行结构化 TS** |

机制 ② 还存在命名与归属混乱：基准文件 `curated-skill-overviews.ts`（514 行）未标语种、语言归属不明；`.zh.ts` / `.en.ts` / `.id.ts` 后缀在两个文件上的用法不一致（一个以 `.zh` 为附加语种，另一个以 `.en` 为附加语种）。这解释了为何上次新增印尼语的提交（`cb107c834`）达到 **262 个文件 / +22889 行**。

### 不做会怎么样
- 三个语种沿用现状追加，约 135 处手工改动中，27 处机制性改动的任一处漏改都不会被 CI 拦截，用户侧表现为「切换了语言但页面没变」或「标题缺字」，只能靠人工全站巡检发现。
- 机制 ② 需手工复制翻译约 5400 行结构化 TS 数据，且无完整性校验，极易出现某语种数据缺失后静默回退。
- 后续每新增一个国家/语种，成本与风险按同一斜率线性累加，国际化扩展变成高风险动作。

### 用户价值
拉美西语用户、日本用户、韩国用户可以用母语完成产品认知、文档阅读与控制台配置；语言切换行为在公开站、文档站与控制台之间保持一致，不出现语言断层与缺字。

### 业务价值
补齐拉美、日本、韩国三个市场的语言底座；同时把「新增一个语言版本」从 27 处机制性硬编码降为 1 处配置声明，使后续地域扩展的边际成本与回归风险显著下降。

## 目标用户与场景
- 目标用户画像：访问 `lightvela.ai` 的拉美西语用户、日本用户、韩国用户；以及需要评审国际站本地化质量的产品、内容、法务与 QA 同学；间接受益方为后续负责新增语种的前端同学。
- 典型场景：
  - 拉美用户从语言切换器选择 Español，官网首页、价格、支持、文档入口与页脚切换为西语，标题与正文无缺字方块。
  - 日本用户直接访问 `/ja-jp/docs/...`，页面识别为日语版本，站内跳转保持 `ja-jp` 前缀。
  - 韩国用户进入 Agent 控制台，通道配置、Skills、Soul、场景任务等核心模块以韩语展示。
  - 前端同学后续要新增第 8 个语种时，只需在 locale 注册表增加一条声明并补齐字典，漏配任一环节会在 `tsc` 或 CI 阶段直接失败。

## 目标
- 产品结果：国际站语言版本从 4 个扩展到 7 个，新增 `es-419`、`ja-JP`、`ko-KR`，与既有语种在切换器、URL 前缀、SEO、文档站与控制台层面完全对等；同时建立单一 locale 注册表，使语言集合成为可校验的配置而非分散在多处的硬编码。
- 业务目标：
  - 三个新语种的公开站主要页面与控制台核心模块可用母语完成基础使用路径，无中文/英文大段残留、无字体缺字。
  - 新增一个语言版本的机制性代码改动点从 27 处降至 1 处配置声明；语言集合不一致或字典缺失能在 CI 阶段被拦截，不依赖人工巡检。

## 范围

### 本次包含

**A. Locale 注册表收敛（机制治理）**
1. 新建单一真源 `frontend/src/i18n/locales.config.ts`，每个 locale 声明：locale code、URL lang 前缀、下拉显示名、触发按钮短标、是否参与 SEO 路径前缀、字典文件路径、是否为必填翻译语种。
2. `public-site-routing.ts` 的 `PublicSiteLocaleCode` / `PublicUrlLang` / `CanonicalPublicUrlLang` 类型、`PUBLIC_SITE_LOCALES`、`PUBLIC_URL_LANGS`、`PUBLIC_URL_LANG_TO_LOCALE`、`LOCALE_TO_PUBLIC_URL_LANG` 以及 `matchPublicLangPrefix` 的正则，全部改为从注册表派生。
3. 将 4 条静默兜底的三元链（`region.ts` 的 `localizedPath`，`language-switcher.tsx` 的 `dropdownOptionLabel`、`intlSiteUrlForLocale`、`currentOption`）改为 `Record<Locale, …>` 全量查表，使漏配在 `tsc --noEmit` 阶段报错。
4. `language-switcher.tsx` 的 `options` 数组与 `i18n/index.ts` 的 `resources` 改为按注册表遍历生成，移除逐语种硬编码。
5. `next-site/source.ts` 的 `docsI18n.languages` 改为从注册表派生。
6. `scripts/i18n-extract.mjs` 改为按注册表循环生成全部语种字典，移除 `en-US` / `id-ID` 硬编码段；`i18n:check` 升级为校验**所有标记为必填的已注册语种**完整度（当前仅校验 `en-US`）。
7. **修复 `scripts/subset-fonts.mjs`**：字符采集源改为按注册表遍历全部语种字典（含遗漏的 `id-ID.json`），并补充西语扩展拉丁字符与标点 `ñ á é í ó ú ü ¿ ¡` 到 `preservedText`；新增子集覆盖度校验，缺字在构建阶段失败。
8. **收敛机制 ②**：将 `curated-skill-overviews.*.ts`、`agent-buddy-soul-test-data.*.ts` 改为 `Record<Locale, Data>` 的目录约定，基准文件明确标注语种归属，统一命名后缀语义；缺失语种回退默认语言且在 CI 中告警，新增语种数据缺失可被发现。
9. **SEO metadata 表治理**：9 个 `src/app/(site)/[lang]/**/page.next.tsx` 中的 18 张 `TITLE_BY_LOCALE` / `DESCRIPTION_BY_LOCALE` 表保持 `Record` 类型穷举保护（不弱化为可选），但需确认 `zh-SG` 与 `zh-CN` 长期重复同一份中文文案的现状是否收敛为共享常量，减少新增语种时的重复录入。

**B. 新增三个语言版本（业务交付）**
9. 新增 `es`（西语，面向拉美市场，URL 前缀 `/es`）、`ja-JP`（URL 前缀 `/ja-jp`）、`ko-KR`（URL 前缀 `/ko-kr`）。注意 `es` 为 2 字母纯语言码，与旧兼容前缀 `en`、`zh` 同级，URL 前缀匹配正则必须按**长度降序**生成，避免未来新增 `es-ES` 时被 `es` 抢先匹配。
10. 语言切换器新增三个语种，并保持 URL 前缀、`localStorage('lw-locale')`、初始语言识别与站内跳转规则一致。
11. 三语种 hash 字典各补齐 2323 条翻译；机制 ② 的结构化数据按新约定补齐三语种。
12. 国际站公开站主要页面补齐三语种：首页、价格页、支持页、更新日志入口、页脚、法律页入口。
13. 国际站文档站补齐三语种文档导航、正文、搜索与 docs manifest，结构与既有语种一致。
14. Agent 控制台核心模块补齐三语种：通道配置、自动任务、Soul/人设、Skills、场景任务、通知与常见状态文案。
15. SEO、sitemap、canonical、hreflang、`html lang`、静态路由与文档路由纳入三个新 locale。
17. 补齐 9 个 SEO 页面的三语种 metadata：`TITLE_BY_LOCALE` 与 `DESCRIPTION_BY_LOCALE` 共 18 张表，合计 54 条 title/description 文案。
16. 三语种文案按当地用户表达习惯处理，避免生硬直译与机翻腔；产品名、模型名、渠道名与专有名词保持跨语种一致。

### 本次不包含
- 国内站 `lightvela.com` 的三语种支持。国内站固定中文，`isCN` 分支下多语言逻辑为 identity，不受本次影响。
- **Models 模块整体本地化**。沿用前置 PRD 的结论，该模块由 Walker 统一调整，本次三语种同样不覆盖 Models 模块，避免重复与冲突。
- 语言偏好账号级持久化。语言仍存于 `localStorage('lw-locale')`，跨设备不同步；此为独立缺口，列入后续方向。
- 首次访问语言自动识别（`Accept-Language` / 地理位置）。国际站裸 `/` 仍固定英文，本次不改此策略；列入后续方向。
- 控制台切语言免刷新。`@tencent/tea-sdk-lightclaw` 的 tea-app i18n 为 init-once 设计，`/agents`、`/settings` 仍保留整页 reload；列入后续方向。
- `gateway-dashboard` 等运营后台的 i18n 接入。其使用者为内部中文用户，按 YAGNI 本次不做。
- 西班牙本土 `es-ES`、墨西哥 `es-MX` 等西语细分变体。本次只做 `es-419` 统一覆盖拉美。
- 三个新地域的支付能力、套餐能力、登录渠道与运营活动。
- 法务条款内容本身的三语种翻译（见「已知依赖」与「待确认问题」）。
- RTL 语言支持。本次三语种均为 LTR，不引入布局镜像能力。
- **三语种文档正文的全量人工翻译**（57 篇 × 3 语种）。本次仅翻译分组名与各篇 title/description，正文通过 `fallbackSourcePrefixes` 回落英文；正文翻译拆为后续独立内容需求。

### 优先级
- P0：A 组第 1-7 项（注册表收敛与字体修复）、B 组第 9-10、12、15 项（locale 注册、切换器、公开站主要页面、SEO）。
- P1：A 组第 8 项（机制 ② 收敛）、B 组第 11、13、14、16 项（字典补齐、文档站、控制台核心模块、文案质量）。
- P2：三语种非核心页面与低频状态文案的精修。

### 已知依赖
- 既有国际站多语言框架、语言切换器与 URL 前缀机制（`public-site-routing.ts`、`region.ts`、`i18n/index.ts`）。
- 既有 `en-US`、`zh-CN`、`zh-Hant`、`id-ID` 四语种文案结构，作为翻译基准与重构回归基线。
- 三语种的翻译产能与母语质量抽检（西语需明确采用拉美用词而非西班牙本土用词）。
- 字体源文件 `assets/fonts/` 下的 `HYRuiYiSong-45J`、`chuangji-hei` 是否含日文假名与韩文谚文字形；若不含，需补充回退字体方案。
- 法务：三个新地域上线是否要求提供对应语言的法务材料。

## 功能详细描述

### 功能点拆解

1. **Locale 注册表（单一真源）**
   - 位置：`frontend/src/i18n/locales.config.ts`。
   - 每条声明包含：`code`（如 `es-419`）、`urlLang`（如 `es-419`）、`displayName`（下拉全称，如 `Español (Latinoamérica)`）、`shortLabel`（触发按钮短标，如 `ES`）、`seoPrefixed`（是否参与 SEO 路径前缀）、`dictionary`（字典文件路径）、`translationRequired`（是否纳入 CI 必填校验）。
   - 该文件是唯一允许新增语言的位置；其余模块一律派生，不得再出现 locale 字面量硬编码。

2. **类型穷举保护**
   - 所有按 locale 分支的逻辑改为 `Record<Locale, T>` 查表。新增 locale 后若未补齐对应条目，`tsc --noEmit` 直接失败。
   - 明确禁止在 locale 分支中使用带 fallback 的三元链或 `startsWith("zh")` 一类前缀猜测，避免静默降级。
   - 注：`localizedPath` 中现有的「简体 `zh-CN`/`zh-SG` 统一映射到 SEO 别名 `zh-sg`」等既有映射语义必须在查表方案中原样保留，重构不改变既有语种的 URL 行为。

3. **字典生成与校验**
   - `i18n-extract.mjs` 按注册表遍历生成全部语种字典，新 key 置空待翻译，保留既有翻译值。
   - `i18n:check` 对所有 `translationRequired` 语种校验完整度，任一语种存在空值即非零退出。
   - 统计输出按语种列出「已翻译/待翻译」条数，不再逐语种硬编码日志。

4. **字体子集覆盖**
   - `subset-fonts.mjs` 字符采集源改为按注册表遍历全部语种字典。
   - `preservedText` 补充西语扩展拉丁字符与标点：`ñÑáéíóúüÁÉÍÓÚÜ¿¡`。
   - 新增校验：子集产物必须覆盖全部语种字典中出现的字符，缺字则构建失败并列出缺失字符。
   - 若字体源不含假名/谚文字形，则为 `ja-JP`、`ko-KR` 配置系统字体回退栈，并在 PRD 交接中标注该视觉差异已知且可接受。

5. **结构化数据文件收敛（机制 ②）**
   - `curated-skill-overviews`、`agent-buddy-soul-test-data` 改为 `Record<Locale, Data>` 目录约定，基准文件明确标注语种。
   - 统一后缀语义：所有语种文件一律带显式语种后缀，不保留「无后缀即某语种」的隐式约定。
   - 缺失语种时回退默认语言渲染，不得报错或白屏；同时 CI 输出缺失清单。

6. **语言切换器扩展**
   - 下拉选项由注册表遍历生成，本次从「4 语种 + 中国站」变为「7 语种 + 中国站」共 8 项。
   - 需处理下拉列表过长问题（见「产品原型说明」）。
   - 切换行为沿用现有规则：SEO 白名单路径切换 URL 前缀，控制台路径仅切 i18n 不改 URL；`/agents`、`/settings` 保留 `reloadAfterSwitch=true`。

7. **SEO 与静态产物**
   - `/es-419`、`/ja-jp`、`/ko-kr` 页面写入正确 `html lang`、`alternate`/`hreflang`、`canonical` 与 sitemap 条目。
   - `hreflang` 中西语使用 `es-419`；需确认搜索引擎对 `es-419` 的识别情况，若不被支持则同时输出 `es` 作为兜底（见「待确认问题」）。

### Demo / 页面结构说明
不新增页面结构，复用现有国际站公开站、文档站与控制台结构。Demo 以分支预览与本地 preview 的 `/es-419/`、`/ja-jp/`、`/ko-kr/`、`/{lang}/docs/...` 与 `/agents/...` 为准。

### 交互说明
- 用户在语言切换器选择新语种后，SEO 白名单路径的 URL 更新为对应前缀，站内跳转保持该前缀；控制台路径不改 URL，仅切换界面语言。
- 从新语种页面点击法律页、文档、首页、控制台入口时，必须保持同语种，不得跳回英文或中文。
- 国内站访问语言切换器时行为不变，仍为「中文 / English + 国际站跳转」。

### 边界条件与异常处理
- 直接访问不存在的 `/es-419/...`、`/ja-jp/...`、`/ko-kr/...` 页面时，沿用现有 404 或回退策略，不出现空白页。
- 单条文案未覆盖时，按 hash 字典既有机制回退中文原文并在 dev 环境告警，不影响页面渲染；上线前通过全站扫描清零明显残留。
- 机制 ② 结构化数据缺失某语种时，回退默认语言渲染，不白屏。
- 字体缺字必须在构建期拦截，不允许流到线上表现为方块字。
- 旧 `localStorage('lw-locale')` 中若存有已下线或非法 locale 值，需按注册表校验并回退默认语言，不得因未知值导致初始化异常。
- `es-419` 的 URL 前缀含数字，需确认 `matchPublicLangPrefix` 正则与静态路由生成、CDN 路由规则均能正确处理。

### 数据埋点需求
现有语言切换与页面访问埋点若含 locale 维度，新增 `es-419`、`ja-JP`、`ko-KR` 枚举；不新增独立埋点。

## 发布站点与同步策略
- 发布范围：国际站 `lightvela.ai`。
- 国际站是否同步：是，本需求只作用于国际站。
- 国内站是否同步：否。国内站固定中文，不新增语言入口。注册表重构会触及国内站共用的 `region.ts` 与 `public-site-routing.ts`，因此国内站需纳入回归范围，但**不新增任何用户可见变化**。
- 差异化原因：本需求服务国际站拉美、日本、韩国三个市场的本地化；国内站不面向这些语言场景。
- 路由与内容影响：新增 `/es-419`、`/ja-jp`、`/ko-kr` 三个语言前缀；影响公开站页面、文档站、控制台核心模块、i18n 字典、字体子集、SEO、sitemap、docs manifest、搜索索引与法律页入口。
- 上线顺序：**分阶段发布**。先上线 A 组注册表收敛与字体修复（对用户无可见变化，仅需既有 4 语种零回归），验证稳定后再上线 B 组三个新语种。三语种之间可按翻译就绪度分批放出，不要求同时上线。

## LightVela 影响面
- 前端页面/路由：国际站公开站、文档站、控制台核心模块、语言切换器、SEO 与 sitemap；`region.ts`、`public-site-routing.ts`、`i18n/index.ts`、`language-switcher.tsx`、`next-site/source.ts`，以及 `src/app/(site)/[lang]/**/page.next.tsx` 共 9 个 SEO 页面的 metadata 文案表。
- 构建与工程：`scripts/i18n-extract.mjs`、`scripts/subset-fonts.mjs`、`scripts/i18n-zh-hant.mjs`（需确认繁体脚本是否也需接入注册表）、`pnpm check` 门禁、静态导出产物。
- Hermes/OpenClaw/运行时：不新增运行时能力；场景任务 prompt 与控制台展示文案涉及 Hermes 自动任务使用体验。
- SkillHub/MCP/工具：不改变工具协议；Skills 展示与场景任务文案需要本地化，且是机制 ② 的主要载体。
- SDK/文档/运营：文档站新增三语种内容；`@tencent/tea-sdk-lightclaw` 侧需确认是否支持新 locale，若不支持则控制台 SDK 区域存在语言断层（见「待确认问题」）。
- 权限/安全/数据：无新增权限或数据处理要求。注册表与字典均为静态资源，不引入用户输入解析。

## 非功能性需求
- 性能指标：新增三语种后，国际站首屏不得出现可感知劣化。当前 i18n 采用静态 import 全量打包（`i18n/index.ts` 注释明确不做懒加载），7 语种字典全量打包的体积影响需实测；若超出可接受范围，则按 locale 做字典分包懒加载，此项作为本次的性能兜底动作。字体子集体积因新增字符集会增长，日韩字形若纳入子集需评估增量。
- 兼容性：沿用国际站现有浏览器与设备兼容要求。
- 安全与权限：无新增权限或安全要求。`localStorage` 中的 locale 值需按注册表白名单校验后使用，不直接拼接进路径或 DOM。
- 国际化 / 无障碍：`html lang` 分别为 `es-419`、`ja-JP`、`ko-KR`；文案自然准确；语言切换器保留 `aria-haspopup`、`aria-expanded`、`aria-selected` 与 `aria-label`，下拉项数量增加后仍需可键盘操作与被辅助技术正确朗读。

## 产品原型说明
- 目标页面/入口：国际站全站 Header 与移动端菜单中的语言切换器（`frontend/src/components/site/language-switcher.tsx`）。
- 用户主路径：点击 🌐 触发按钮 → 展开语言列表 → 选择目标语言 → 页面切换语言（SEO 路径同时更新 URL 前缀）。
- 页面结构：不新增页面。仅语言切换器的下拉列表项由「4 语种 + 中国站 = 5 项」增加到「7 语种 + 中国站 = 8 项」。
- 关键组件：`DropdownSwitcher`（桌面下拉）、`InlineSwitcher`（移动端平铺按钮）。
- 状态：默认 / 展开 / 当前选中（带 Check 图标）/ 移动端平铺选中态。
- 主要操作：切换语言、跳转中国站。
- 需要设计确认：
  1. 8 项下拉是否需要分组（例如「中文系 / 其他语言」）或分隔线，避免列表过长且视觉扁平。
  2. 移动端 `InlineSwitcher` 采用平铺按钮，7 个语种全称按钮（如 `Español (Latinoamérica)`）会明显换行堆叠，需确认是否改为下拉或两列布局。
  3. 触发按钮短标方案：现有为 `EN` / `中` / `繁` / `ID`，新增 `ES` / `JA` / `KO` 后是否仍清晰可辨。
  4. 下拉全称的站点前缀现为 `International Site - ` / `国际站 - `，加上西语全称后单行长度明显增加，需确认最小下拉宽度（现为 `min-w-[168px]`）。
- 需要前端确认：下拉项由注册表遍历生成后，中国站入口的插入位置与分隔线逻辑如何保持现有「国内站置顶、国际站置底」的差异化排序。

## 方案决策
- 采用方案：**方案 A** —— 先建立单一 locale 注册表并将 27 处机制性硬编码收敛为配置派生 + 类型穷举 + CI 校验，再按注册表新增 `es-419`、`ja-JP`、`ko-KR` 三个语言版本。
- 选择理由：
  - 本次一次性新增 3 个语种，沿用现状的手工改动量约 135 处，且多数漏改不报错，回归成本高于重构本身。
  - 已发现的 `subset-fonts.mjs` 漏配 `id-ID` 缺陷证明「靠人工同步多处硬编码」在实践中已经失效过一次，且长期无人发现。
  - 本次有 3 个真实新语种可作为重构正确性的验证载体，重构与业务交付互为验证，时机最优。
  - 收益可量化：后续新增语种的机制性改动点从 27 处降至 1 处，且漏配从「线上静默降级」前移为「CI 失败」。
- 备选方案与取舍：
  - **方案 B：只收敛 hash 字典层，结构化 TS 数据文件仍按语种复制**。代价与风险更小，但机制 ② 约 1800 行/语种、本次共约 5400 行的手工复制翻译成本完全没有解决，最大成本项未触及，不采用。
  - **方案 C：先按现状新增 3 语种快速上线，重构拆为后续独立需求**。上线最快，但 135 处手工改动中的三元链漏改不报错、CI 拦不住，且后续重构需把这些位置再改一遍，总成本更高、回归风险叠加，不采用。
  - **方案 A 拆两期（一期重构、二期加语种）**：与本次采用方案的实质差异仅在交付节奏。本次已通过「分阶段发布」吸收该诉求：A 组先上线并回归既有 4 语种，再上线 B 组，无需拆成两个独立产品父单。
- 延后或不做：语言偏好账号级持久化、首次访问语言自动识别、控制台切语言免刷新、`gateway-dashboard` i18n 接入、Models 模块本地化、西语细分变体、RTL 支持。

## 验收标准

**A 组：注册表收敛（对用户无可见变化）**
1. 新增语言的**机制性**代码改动点收敛为 1 处：在 `frontend/src/i18n/locales.config.ts` 增加一条声明后，无需修改 `public-site-routing.ts`、`region.ts`、`i18n/index.ts`、`language-switcher.tsx`、`next-site/source.ts`、`i18n-extract.mjs`、`subset-fonts.mjs` 中的任何 locale 字面量。
1.1 SEO metadata 表（9 个页面 / 18 张 `Record`）仍需按语种补文案，但必须保持类型穷举保护：漏补条目时 `tsc --noEmit` 失败，不允许为省事改成可选类型或 `Partial`。
2. 在注册表新增一个语种但不补齐字典与查表条目时，`pnpm check`（含 `tsc --noEmit`）与 `i18n:check` 必须失败，且错误信息指明缺失项；不得静默通过或静默回退。
3. 既有 4 语种（`en-US` / `zh-CN`(`zh-SG`) / `zh-Hant` / `id-ID`）在重构后零行为变化：语言切换、URL 前缀（含 `zh-CN`→`zh-sg` 别名映射与旧 `/en`、`/zh` 兼容）、`localStorage` 持久化、SEO/sitemap/hreflang、docs manifest 与文档搜索全部与重构前一致。
4. 国内站（`REGION=cn`）构建产物与用户可见行为零变化。
5. 字体子集覆盖度校验生效：`id-ID.json` 已纳入采集源；构造一个字典含未覆盖字符的用例时构建失败并列出缺失字符。
6. 机制 ② 结构化数据改为 `Record<Locale, Data>` 后，基准文件语种归属明确、后缀语义统一；缺失某语种时回退默认语言渲染不白屏，且 CI 输出缺失清单。

**B 组：三个新语言版本**
7. 语言切换器展示 Español (Latinoamérica)、日本語、한국어；选择后 URL 前缀分别为 `/es-419`、`/ja-jp`、`/ko-kr`，刷新后语言保持。
8. `/es-419/`、`/ja-jp/`、`/ko-kr/` 及其 `/docs/...`、法律页与主要公开页面可正常访问，站内跳转不跳回其他语言。
9. 国际站七语种的路由、SEO、sitemap、canonical、hreflang、`html lang`、docs manifest 与文档搜索均可正常生成。
10. 三语种文档侧栏数量与结构与目标国际站文档集合一致，正文无明显英文或中文残留。
11. Agent 控制台除 Models 模块外的核心模块以三语种展示，无中文残留或英文大段残留。
12. 场景任务与 Skills 的结构化数据在三语种下字段标签与内容语种一致，不发生跨语种串用。
13. 三语种页面在标题（`font-heading`）与正文中均无缺字方块；西语 `ñ á é í ó ú ü ¿ ¡` 正常显示。
14. `pnpm check` 及相关 i18n、SEO、文档、场景任务测试全部通过。
15. 新增三语种后国际站首屏性能无可感知劣化；若字典全量打包导致体积超出可接受范围，已完成按 locale 分包懒加载。

## 发布与观测
- 灰度/开关：A 组不新增业务开关，通过分支预览回归既有 4 语种后合入。B 组按语种通过 locale 注册表的启用标记控制放出，可先在分支预览验证再逐语种开启；发现问题可单独关闭某一语种入口而不影响其他语种。
- 日志/埋点/指标：观测三个新 locale 的页面访问量、语言切换占比、文档搜索使用、控制台关键操作失败率；观测 dev/预发环境的 i18n missing key 告警数量作为文案覆盖度参考。
- 回滚：
  - B 组：在注册表中关闭对应语种启用标记即可隐藏该语言入口，其余语种不受影响。
  - A 组：属结构性重构，回滚需整体 revert。因此要求 A 组独立成一次可回滚的提交，不与 B 组的三语种内容混合提交。

## 开发前已查证的事实（原待确认问题 3、4 的结论）

### 实际改动范围修正（重要，高于初版评估）

开发前全量扫描确认：`frontend/` 下共 **66 个源文件**含 locale 字面量，且**项目不存在单一 locale 真源，而是 5 条互不 import 的镜像管线**。这是「漏改后静默回退」的根本原因，也是本次重构的真正目标。

| 管线 | 真源文件 | 独立原因（代码注释自述） |
|---|---|---|
| ① SPA / Vite 层 | `src/lib/public-site-routing.ts` | `PUBLIC_SITE_LOCALES` + `PUBLIC_URL_LANGS` |
| ② Next.js 层 | `next-site/public-locale.ts` | 「与 `src/*` 是两条独立打包管线，各自维护一份镜像」 |
| ③ i18next 资源层 | `src/i18n/index.ts` | 「刻意在 i18n 模块内自持一份，避免跨层耦合」 |
| ④ Node 脚本层 | `scripts/sync-fumadocs-content.mjs` | `.mjs` 无法 import `.ts`，手动镜像 |
| ⑤ SEO 校验层 | `src/lib/seo-data.ts` | 不依赖 `import.meta.env`，自持 `UrlLang` 类型 |

新增一个语种必须同时修改这 5 处，任一处漏改即导致该语种在对应链路静默回退，且多数不报错。

另有两处此前未识别的结构性成本：

1. **每语种一个搜索 API 路由文件**：`src/app/api/search/{zh-sg,zh-hant,id-id}/route.next.ts`。新增语种需**新建**对应目录与文件（C 类改动）。
2. **文档内容为全量人工翻译**（本次最大工作量，且属内容生产而非工程改动）：

| 目录 | 篇数 | 体积 |
|---|---|---|
| `src/content/docs/global/`（简体基准） | 57 | 484K |
| `src/content/docs/en/` | 57 | 532K |
| `src/content/docs/id/` | 57 | 564K |

即上次新增印尼语时对 57 篇文档做了**全量人工翻译**。若三个新语种同样全量翻译，内容量约 **171 篇长文 / 1.5MB 文本**，远超工程改动成本。

**因此文档站范围采用降级策略**：复用脚本已有的 `fallbackSourcePrefixes: ['en','global']` 机制（`id-ID` 已在用），三语种**正文回落英文**，仅**必须**人工翻译各语种的分组名（9 条）与 57 篇文档的 title/description（114 条），确保侧边栏、导航与 SEO 不出现英文。正文全量翻译拆为后续独立内容需求，按市场反馈分批推进。此降级已写入「本次不包含」与验收标准。



### 字体字形覆盖（阻塞项，已查证）

使用 fontTools 实测 cmap 覆盖情况：

| 字体 | 日文假名 | 韩文谚文 | `ñÑ` | `¿¡` | `áéíóúü` |
|---|---|---|---|---|---|
| `assets/fonts/HYRuiYiSong-45J.ttf`（唯一字体源，`font-heading`） | 全缺 | 全缺 | **缺** | **缺** | 覆盖 |
| `public/fonts/chuangji-hei.woff2`（7247 字形） | 全缺 | 全缺 | **缺** | **缺** | **缺** |
| 当前 subset 产物 `HYRuiYiSong-45J.subset.woff2`（1228 字形） | 全缺 | 全缺 | **缺** | **缺** | **缺** |

结论与处理方式：
- 日语假名、韩语谚文：两个字体源均无字形，**必须**为 `ja-JP`、`ko-KR` 配置系统字体回退栈（如 `Hiragino Sans` / `Yu Gothic` / `Noto Sans JP`，`Apple SD Gothic Neo` / `Malgun Gothic` / `Noto Sans KR`）。日韩标题与中英标题存在字形风格差异，属已知可接受差异，需在设计交接中说明。
- 西语：`ñ` 为西语极高频字符（`España`、`año`、`señor`、`mañana`），而源字体 `HYRuiYiSong-45J` 本身**不含 `ñÑ ¿¡`**。因此仅在 `preservedText` 中补字符**不足以解决**，必须同时为西语配置拉丁字体回退栈；`áéíóúü` 可由源字体提供，需确保纳入 subset 采集。
- 故字体工作拆为三项：① 修正 subset 采集源漏配（含 `id-ID`）并补 `áéíóúü` 等源字体已有字符；② 为源字体无字形的字符配置回退栈；③ 新增覆盖度校验，且必须把「源字体无此字形」与「subset 漏采集」区分报错，避免误判为漏采集。

### tea-sdk locale 支持（已查证，属既有断层）

`node_modules/@tencent/tea-sdk-lightclaw@1.12.1` 的 `i18n/translation/` 下**仅有 `zh.js`（4K）与 `en.js`（48K）两个语言包**，无其他语种。

结论：
- `zh-Hant` 与 `id-ID` 在 `/agents`、`/settings` 的 SDK 渲染区域**早已回退中文或英文**，语言断层是既有现状，非本次引入。
- `es-419`、`ja-JP`、`ko-KR` 在 SDK 区域同样回退英文。本次**接受**该现状，不阻塞开发。
- 应作为独立需求推动 SDK 侧扩展语言包；本 PRD 记录现状，并在验收标准中明确排除 SDK 渲染区域。

## 待确认问题
1. ~~西语 locale 选型~~ **已定稿：采用 `es` + URL 前缀 `/es`**（2026-08-21）。选择理由：前缀最简短、SEO 兼容性最好、无数字前缀带来的路由与 CDN 风险。已知取舍：不区分拉美与西班牙本土，未来若需单独的西班牙本土版本需再拆分为 `es-ES`。
2. ~~hreflang 是否需兜底输出 `es`~~ **已随问题 1 消解**：直接使用 `es` 作为 hreflang 值。
3. 三语种的翻译产能与质量责任方是谁？西语是否明确采用拉美用词（而非西班牙本土用词）并有母语抽检？
4. 三个新地域上线是否要求提供对应语言的法务材料？需法务确认，若需要则单独立需求承接。
5. `scripts/i18n-zh-hant.mjs`（繁体 OpenCC 生成脚本）是否也需接入注册表？该脚本为 `zh-Hant` 专属，与通用语种机制不同构，需确认保持独立还是统一纳管。
6. Models 模块本地化仍由 Walker 统一承接，本次三语种同样不覆盖。需确认该模块的三语种补齐时间点，避免长期语言断层。
7. 日韩标题采用系统字体回退带来的字形风格差异是否需设计确认？（技术结论已定，仅需设计侧接受度确认，不阻塞开发。）
