# Blog 页面

## 目标

为国际站提供一个可由首页页脚访问的 Blog 入口。
当前提供文章卡片、分类筛选和独立文章阅读页。

## 路由与本地化

- `https://lightvela.ai/blog` 是默认英文入口。
- 所有已发布的国际站语言前缀都必须提供对应路由，例如 `/zh-sg/blog`、`/es/blog`、`/ja/blog` 与 `/ko/blog`。
- 页面标题、描述、Header、Footer 和筛选项随当前公开站语言本地化。
- 文章内容保持英文，不因为切换站点语言而被翻译或替换。

## 页面结构

- 复用 `PublicSiteHeader`、`PublicHeaderAuthIsland`、`LegalFooter` 和国际站 `LightVelaFooter` 的现有公开页面组合。
- 主内容使用白色背景、居中排版和充足留白。
- 页面中心展示大号 `Blog` 标题。
- 标题下方展示可切换的文字分类：All、Announcement、Product 与 Use Cases。
- 当前分类通过深色文字和细下划线表达，不使用胶囊、描边、阴影或额外装饰形状。
- 文章卡片使用桌面端三列、平板两列、移动端单列布局。
- 每张卡片只展示轻微圆角封面、标题和 `Category · Date` 元信息，不展示摘要。
- 点击整张卡片进入 `/blog/[slug]` 对应的独立文章页。
- 文章内容区与三列列表共用 `max-w-5xl` 总宽度。
- 文章封面位于返回链接之后、标题之前，使用 16:9 的 `object-cover` 裁剪和轻微圆角；正文内图片保持原比例，窄竖图可单独限制宽度。
- 所有文章正文末尾使用固定的分享组件：细分隔线、Share、Copy link、X、LinkedIn 和 Facebook。

## 页脚入口

- 仅国际站首页的 Footer `Product` 栏新增 `Blog` 作为第一个链接。
- 链接必须使用当前语言对应的公开路径，并指向同语言的 Blog 页面。
- 国内站 Footer 不新增该入口。

## 可访问性与交互

- 分类控件使用语义化 button，并维护可感知的选中状态。
- 键盘聚焦必须可见，且切换分类无需页面跳转。
- 卡片链接需要包含文章标题作为可访问名称。

## SEO

- 每个 Blog 路由生成与当前语言匹配的 title、description、canonical、Open Graph 与 alternate language metadata。
- 将 Blog 加入公开站的 SEO 路由登记与 `llms.txt` 内容索引，避免静态导出后出现缺失入口。

## 验收标准

- 访问 `/blog` 时显示现有公开 Header、居中的 Blog 标题、四个分类和 Footer。
- 国际站首页 Footer 的 Product 第一项为 Blog，且链接到 `/blog` 或当前语言前缀的 Blog 路径。
- 切换任一分类时选中状态正确更新，页面不出现外框或多余装饰，且内容区只显示对应分类的文章卡片。
- 文章卡片能够进入独立文章页，文章页显示英文正文、用户提供的图片、标题、分类和上传时间。
- 文章页的封面、正文和分享结尾总宽度与 Blog 三列列表一致，Copy link 复制当前文章的 `lightvela.ai` 公开链接。
- 所有已发布国际站语言路由均能静态导出，并使用本地化的界面文本与 metadata。
- 国际站与国内站构建、类型检查、国际化检查和相关路由测试均通过。
