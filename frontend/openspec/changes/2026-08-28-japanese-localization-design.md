# 国际站日语完整本地化设计

## 目标

在国际站 `lightvela.ai` 完整交付日语版本，使公开站、控制台宿主、结构化内容、61 篇 Docs、法务页面、SEO 与字体达到当前西语版本的交付范围。日语使用 `ja-JP`，公开 URL 前缀使用 `/ja-jp`。

## 当前事实

- `ja-JP` 已存在于 locale 注册表、TypeScript 联合类型和 i18next resources 中。
- `switcherVisible` 与 `translationRequired` 均为 `false`，因此 `/ja-jp/` 当前返回 404。
- `ja-JP.json` 与中文基准同为 2654 个 key，仅 3 条已有日语译文。
- `src/content/docs/ja/` 不存在，Docs 当前没有日语源文件、搜索路由或 manifest 条目。
- SEO、JSON-LD、法务和多个 Agent 结构化内容仍包含西语专属分支。
- 自托管字体不含日文假名，日语必须使用系统字体回退。

## 发布范围

### 包含

- 国际站 2654 条 hash UI 字典的完整日语译文。
- Soul、人设测试、curated Skills、Experts、场景任务和自动任务等代码可控结构化内容。
- 61 篇国际站 Docs 日语正文、标题、描述、搜索与路由。
- 隐私政策、Cookie 政策、服务条款的完整日语译文；开源许可证正文保留英文。
- `/ja-jp/**` 静态路由、title/description、canonical、hreflang、sitemap、Open Graph、JSON-LD 与 `html lang="ja-JP"`。
- 日语系统字体回退、桌面与移动端语言切换器回归。
- 自动全量校验、母语抽检清单与法务全文审阅门禁。

### 不包含

- 国内站用户可见变化。
- Models 模块和 `@tencent/tea-sdk-lightclaw` 内部语言包。
- 自动语言识别、账号级语言同步和免刷新切换。
- 日本市场支付、登录渠道、套餐或运营活动调整。
- 韩语内容；韩语在日语验收后复用本设计另行执行。

## 核心方案

### 1. 注册表驱动发布

`src/i18n/locales.json` 继续作为发布真源。实现期间保留日语隐藏；翻译、路由、SEO、Docs、字体与 A1 审阅门禁全部就绪后，最后将 `ja-JP.switcherVisible` 和 `translationRequired` 同时设为 `true`。

所有静态参数、切换器选项、SEO locale 集合和字体输入必须从注册表的发布状态派生。现有西语单例判断改为 locale-indexed records 或 resolver，不能继续复制 `locale === "es"` 分支。

### 2. UI 字典

以 `en-US.json` 的英文译文作为日语初译语义底稿，以 `zh-CN.json` 和 `zh-to-key.json` 作为 hash 与中文原文事实源。保护产品名、渠道名、模型名、命令、占位符、HTML 标签和换行结构。译文通过 `scripts/i18n-apply.mjs` 的中文原文映射写入，不根据 hash 猜测原文。

日语术语表至少固定：

| 概念 | 日语 |
| --- | --- |
| Agent | Agent |
| Hermes Agent | Hermes Agent |
| Skill / Skills | スキル |
| Automation | 自動タスク |
| Channel | チャネル |
| Memory | メモリ |
| Persona | ペルソナ |
| Model | モデル |
| Provider | プロバイダー |

### 3. 结构化内容

为西语已覆盖的结构化内容增加日语数据源，并把选择逻辑收敛为显式 locale resolver。隐藏语种允许英文 fallback；发布语种的完整性测试必须证明核心结构化内容不再 fallback。

### 4. Docs

以 `src/content/docs/en/**` 为事实底稿，在 `src/content/docs/ja/**` 创建相同的 61 个 Markdown 文件。保持文件集合、标题层级、表格、代码块、图片目标和内部链接意图一致；日语内链使用 `/ja-jp/docs/**`。

翻译分三批执行：工具与配置类、Use Cases、Compare 与 Hermes Agent。每批运行结构 parity；最终生成日语搜索路由和 `DOCS_ROUTE_SLUGS["ja-jp"]`，并证明所有发布 slug 读取日语源而不是 fallback。

### 5. 法务

隐私、Cookie 和服务条款提供完整日语 copy，并加入英文版本优先说明：

> 英語版と本日本語訳との間に矛盾または不一致がある場合、適用法令に別段の定めがない限り、英語版が優先されます。

开源许可证原文保持英文，只翻译页面标题、说明和结构标签。法务译文在入口开放前必须全文人工审阅。

### 6. SEO 与 metadata

日语页面使用自指 canonical，`hreflang="ja-JP"`、`og:locale="ja_JP"` 和 `html lang="ja-JP"`。title、description、OG 与 canonical 必须对应同一真实 URL；只有真实生成且返回 200 的路径才能进入 sitemap/hreflang。

SEO 文案使用自然日语表达 LightVela、クラウド AI Agent、パーソナル AI Agent、Hermes Agent、常時稼働、長期記憶、自動タスク和スキル，不做关键词堆砌。

### 7. 字体与性能

日语页面的 heading/body 使用 `Hiragino Sans`, `Yu Gothic`, `Noto Sans JP`, system-ui 回退，不尝试把完整日文字形加入 `HYRuiYiSong` 子集。语言切换器不新增动画或交互原语。

比较日语开放前后的国际站构建产物。若首屏 gzip JS 增量超过 100 KB 或 10%，将非当前 locale 字典改为按 locale 动态加载；否则保持现有同步初始化，避免引入不必要的异步状态。

## 错误与回滚

- 字典缺失、占位符/HTML/换行结构不一致：`i18n:check` / `i18n:validate` 失败。
- Docs 文件、图片、代码块、标题层级或 slug 不一致：Docs parity 失败。
- 日语路径缺少 self-canonical、hreflang、OG locale 或 sitemap：SEO 测试/构建失败。
- 结构化内容发生中文串用或英文 fallback：locale 专项测试失败。
- 母语抽检或法务审阅未通过：保持 `switcherVisible=false`，不开放入口。
- 开放后需回滚：只关闭日语注册表发布标记，其他 locale 不受影响。

## 验收标准

1. `ja-JP.json` 与中文基准 key 集一致、2654/2654 非空，结构校验为零错误。
2. `/ja-jp/`、主要公开页、法律页和 61 个 `/ja-jp/docs/**` slug 返回 200 并保持日语路径。
3. 核心控制台宿主和结构化内容无明显中文残留或大段英文 fallback；Models/SDK 区域除外。
4. 日语 title、description、canonical、hreflang、sitemap、OG、JSON-LD 与 `html lang` 一致。
5. 日文假名无缺字方块，语言切换器在桌面和移动端可键盘操作且不溢出。
6. 国内站无日语入口、路由或用户可见变化。
7. 自动门禁通过，日语母语者抽检核心 UI/Docs，法务全文人工审阅后才允许合入发布。

## 已采用与未采用方案

- 采用：同一分支先完成日语全范围，再复用流水线完成韩语。
- 未采用：日韩同时实现；差异量过大，不利于逐语种验收和回滚。
- 未采用：Docs/法务回退英文的快速版；不满足与当前西语范围对齐。
- 未采用：把日韩全部字形打入自托管字体；体积不可接受且现有字体源不具备字形。

## 本地日语预览补充设计

为便于发布前人工验收，本地国际站允许通过显式开发环境变量预览尚未发布的日语；生产构建继续只认注册表的双发布标志。

- 采用：增加 `NEXT_PUBLIC_PREVIEW_LOCALES=ja-JP`（同时兼容 Vite 同名变量），仅在非生产环境把指定 locale 加入运行时路由与语言切换器集合。
- 数据流：环境变量 → 解析并校验已注册 locale → 与正式发布集合合并 → 切换器、公开路由、Docs 路由和 i18n 初始语言共同消费。
- 安全边界：生产环境忽略预览变量；国内站忽略预览 locale；未显式设置变量时保持当前 `/ja-jp/` 404 和切换器隐藏行为。
- 测试：覆盖默认隐藏、本地显式开放、生产拒绝、国内站拒绝、未知 locale 拒绝，并以浏览器验证首页切换、`/ja-jp/`、Docs 和法务页。

备选但不采用：直接把注册表发布标志改为 `true`，会让预览与正式发布状态混在一起；单独增加 `/preview/ja-jp` 私有路由则无法验证真实语言切换、canonical 和 Docs 路由链路。
