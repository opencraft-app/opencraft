# Blog 页面

## 目标

保留现有 Blog 列表与文章阅读能力。国际站恢复首页与共享 Footer 的 Blog 入口，国内站入口继续隐藏；读者仍可通过已有 URL 直接访问。
当前提供文章卡片、分类筛选和独立文章阅读页。

## 路由与本地化

- `https://lightvela.ai/blog` 是默认英文入口。
- 所有已发布的国际站语言前缀都必须提供对应路由，例如 `/zh-sg/blog`、`/es/blog`、`/ja/blog` 与 `/ko/blog`。
- 页面标题、描述、Header、Footer 和筛选项随当前公开站语言本地化。
- 四篇文章提供完整中英文：国内站默认中文，国际站默认英文；国际站选择简体中文或繁體中文时，标题、摘要和正文同步切换，其他暂未翻译的语言回退英文。文章及卡片标题使用对应 lang；图片保持用户提供的原始语言。

## 页面结构

- 复用 `PublicSiteHeader`、`PublicHeaderAuthIsland`、`LegalFooter` 和国际站 `LightVelaFooter` 的现有公开页面组合。
- 主内容使用白色背景、居中排版和充足留白。
- 页面中心展示大号 `Blog` 标题。
- 标题下方展示可切换的文字分类：All、Announcement、Product 与 Use Cases。
- 当前分类通过深色文字和细下划线表达，不使用胶囊、描边、阴影或额外装饰形状。
- 文章卡片使用桌面端三列、平板两列、移动端单列布局。
- 每张卡片只展示轻微圆角封面、标题和 `Category · Author · Date` 元信息，不展示摘要。
- 点击整张卡片进入 `/blog/[slug]` 对应的独立文章页。
- 文章内容区与三列列表共用 `max-w-5xl` 总宽度。
- 所有列表及详情封面统一为 16:9 容器，图片铺满并以 `object-cover` 裁剪，轻微圆角；可设置裁剪锚点保护图中文字，当前首篇封面靠左。文章封面位于返回链接之后、标题之前；正文内图片保持原比例并按需加载，窄竖图可单独限制宽度。
- 所有文章正文末尾使用固定的分享组件：细分隔线、Share、Copy link、X、LinkedIn 和 Facebook。

## 页脚入口

- 国际站首页的静态片段与共享 Footer 在产品栏展示 Blog 链接，使用当前语言前缀；国内站继续隐藏 Blog 导流链接。
- 国际站所有已发布语言同步展示入口；国内站桌面与移动端不保留空占位或不可聚焦文字。
- Blog 内部保留文章与列表之间的阅读跳转；页面内容、直接访问与既有 SEO 索引不因入口隐藏改变。

## 可访问性与交互

- 分类控件使用语义化 button，并维护可感知的选中状态。
- 键盘聚焦必须可见，且切换分类无需页面跳转。
- 卡片链接需要包含文章标题作为可访问名称。

## SEO

- Blog 列表按界面语言生成 metadata；文章 title、description、Open Graph locale 依据实际正文语言。国际站简体与繁体文章分别使用 /zh-sg 与 /zh-hant canonical，其他语言前缀回退英文裸路径；sitemap 登记实际可用的文章语言版本，hreflang 包含国内 zh-CN、国际 en-US、zh-SG 与 zh-Hant，x-default 指向国际英文版。
- 将 Blog 加入公开站的 SEO 路由登记与 `llms.txt` 内容索引，避免静态导出后出现缺失入口。

## 验收标准

- 访问 `/blog` 时显示现有公开 Header、居中的 Blog 标题、四个分类和 Footer。
- 国际站首页与共享 Footer 展示 Blog 链接，已发布语言入口与当前语言匹配；国内站继续隐藏，其余导航顺序与跳转正常。
- 切换任一分类时选中状态正确更新，页面不出现外框或多余装饰，且内容区只显示对应分类的文章卡片。
- 文章卡片能够进入独立文章页，文章页显示随当前选择语言切换的中英文正文、用户提供的图片、标题、作者和上传时间。
- 文章页的封面、正文和分享结尾总宽度与 Blog 三列列表一致，Copy link 复制当前站点和正文语言的公开链接。
- 所有已发布国际站语言路由均能静态导出，界面本地化，文章 metadata 与实际正文语言一致。
- 国际站与国内站构建、类型检查、国际化检查和相关路由测试均通过。

## 2026-09-28 当前文章目录

列表将 Jasmin Zhao 的英文发布介绍排在首位，其余三篇保持原有顺序。该篇封面、首页、创建 Agent、线上交流、Telegram 与 Workbench 六张图使用用户补充的原图替换 PDF 截图。

- `dsh-revived-broken-hermes-agent`：只花 0.25 元，就让 DSH 救活了 Hermes Agent；Walker Cao；Use Cases；中文。
- `hermes-dsh-pelican-cup`：我的两个 Agent，结伴参与了“鹈鹕杯”；Walker Cao；Use Cases；中文。
- `hermes-deepseek-harness-10x-efficiency`：别再让Agent单干了！我让Hermes和DSH组队后，效率提升了10倍；Walker Cao；Use Cases；中文。
- `lightvela-personal-ai-cloud-now-live`：LightVela: Your Personal AI in the Cloud Is Now Live；Jasmin Zhao；Product；英文。
- 原七篇源稿保留在 `blog-content-archive.ts`，不参与公开清单、静态路由、sitemap 或 llms.txt。修复与组队文章复用原 slug，但替换为本轮原稿；其余旧 slug 返回 404。
- 图片存为本地 WebP，按原稿顺序展示；缺图用空白区域保留位置，不请求空地址或任意替代图。组队文章封面已使用用户后续提供的结对编程原图补齐。

## 统一文章结尾与链接

- 每篇文章在分享区前使用同一个社群组件。国际站展示 Discord、WhatsApp 的可扫描二维码与直达链接；国内站展示共享配置中的微信交流群二维码。原稿末尾重复的进群图片与引导移除。
- 入群二维码来自项目现有社群配置；国际站二维码由邀请链接生成，避免二维码与链接不一致。
- 试用链接显示文案和 href 去除 from、utm_*、ref、source 追踪参数，首页试用链接指向当前站点域名。分享链接也使用当前站点的文章 canonical。
