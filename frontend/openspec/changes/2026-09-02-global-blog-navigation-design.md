# 国际站 Blog 入口与页面头部统一设计

## 背景

现网 `https://lightvela.ai/` 首页的顶部公开导航没有 Blog 入口。

首页 Footer 的 Product 栏也没有展示 Blog，而 `/blog` 页 Footer 已展示该入口。

国际站新版首页由 `InternationalHomePage` 注入静态 HTML 片段，首页的导航和 Footer 不经过 React 公共站点组件。

Blog 页及其他公开页使用 React 公共站点组件，Blog 尚未注册到公共导航数据，因此两套首页头部实现都缺少 Blog 顶部入口。

## 目标

- 在国际站所有公开页面的顶部导航中展示 Blog。
- 在国际站首页 Footer 的 Product 栏展示 Blog，并保持 Blog 页与首页使用相同的 Product 链接顺序。
- Blog 顶部导航沿用首页当前的三栏布局、链接样式、认证操作和响应式菜单。
- Blog 页继续使用 `immersive` 头部外观，保留当前透明度，让蓝色页面背景透过头部显示。
- 国内站顶部导航和 Footer 均不展示 Blog。
- 多语言国际站链接使用现有 `publicSiteHref()` 生成对应的公开路径。

## 方案

扩展 `PUBLIC_SITE_NAV_ITEMS` 的导航项模型，增加 `globalOnly` 标记和 `blog` section。

公共头部根据 `isGlobal` 过滤 `globalOnly` 项，并继续通过 `publicSiteHref('/blog', locale, { localized })` 生成语言前缀。

更新国际站首页生成脚本的导航插入、Blog 文案和 `/blog` 语言路径规则，并同步更新七个国际站静态片段。

Footer 继续由 `getFooterSections()` 提供 React 公共页面的 Product 栏 Blog 第一项，同时由首页生成脚本提供静态首页的同位置入口。

BlogPage 保留现有 `PublicSiteHeader appearance="immersive"` 配置，不复制或覆盖头部视觉样式。

## 数据流

`PUBLIC_SITE_NAV_ITEMS` 提供 React 公共页面的国际站 Blog 导航项。

`PublicSiteHeader` 读取站点区域和当前 locale，过滤导航项并生成 Blog 链接。

`InternationalHomePage` 读取首页静态片段，片段由 `import-international-homepage.mjs` 生成并包含 Blog 导航和 Footer 链接。

`BlogPage`、文章页和其他公开页面继续复用 `PublicSiteHeader`，因此 React 页面入口行为保持一致。

`LightVelaFooter` 读取同一份 Product 链接数据，国际站首页和 Blog 页都显示 Blog。

## 可访问性与视觉约束

Blog 使用普通导航链接，不新增图标、胶囊、阴影或独立装饰。

当前页通过既有 `isPublicSiteNavActive()` 逻辑显示选中态。

桌面和移动端菜单都必须包含 Blog，并保留现有键盘焦点样式。

Blog 页继续使用现有透明头部，不新增动画或改变既有透明度。

## 测试策略

- 在公共导航测试中断言国际站 Blog 导航项、标签和语言前缀路径。
- 在国际站首页片段测试中断言七种语言的顶部导航和 Footer Product 栏都包含 Blog。
- 在公共头部测试中断言国内站不出现 Blog，并在国际站渲染测试中断言 Blog 出现在桌面导航和移动菜单。
- 在 Footer 测试中保留国际站 Blog 第一项和国内站不出现 Blog 的断言。
- 运行 Blog、Header、Footer 和导航定向测试。
- 运行 `pnpm check`、`pnpm i18n:check`、`git diff --check` 和国际站构建。
- 在本地国际站桌面与移动视口检查首页和 Blog 页的顶部导航、透明度、Footer Blog 入口及无横向溢出。

## 非目标

- 不翻译或改写 Blog 正文。
- 不增加国内站 Blog 路由或入口。
- 不改变登录、语言切换和首页 CTA 行为。
- 不修改文章数据、Footer 其他链接或页面主体布局。
