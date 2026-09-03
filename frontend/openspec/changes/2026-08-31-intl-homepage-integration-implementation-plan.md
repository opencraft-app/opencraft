# 国际站 V2 多语言首页接入 Implementation Plan

> **For agentic workers:** 实现必须使用 `test-driven-development`；完成声明前必须使用 `verification-before-completion`。本计划只允许修改国际站 V2 首页接入范围，禁止 commit、push、MR 或发布，直到用户验收。

**Goal:** 将已验收的 LightVela V2 首页接入正式国际站七个已发布首页语言，统一页面结构与动态，保留各 locale 文案、字体、图片和现有本地模块，并让全部可点击导航使用正式路由或正式外链。

**Architecture:** 新增国际站首页 Server 组件，在构建时按 locale 读取 public 目录中的静态 HTML fragment 并输出 SSR 正文；配套 Client 运行时按语言挂载生命周期重新加载动效脚本。根路由和国际站 locale 路由通过纯函数判定是否选择新版首页，国内站和 `zh-CN` 继续复用现有 `PublicHomePage`。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 5.9、Vitest 4、静态 HTML/CSS/JavaScript。

## Global Constraints

- 仅国际站 `en-US`、`zh-SG`、`zh-Hant`、`id-ID`、`es`、`ja-JP`、`ko-KR` 首页启用新版；国内站和 `zh-CN` 保持现状。
- 不引入 iframe、不新增第三方依赖、不修改 API/鉴权/计费/发布配置。
- 所有静态资源使用 `/lightvela-intl-home/` 绝对路径。
- fragment 不允许 `href="#"`、`javascript:`、本地 HTML 链接或未解析相对资源。
- 简体中文作为结构与动态基准，繁体中文完整对齐；非中文标题使用英文版 editorial 字体基准。
- 页脚、用户评价和 DeepSeek Harness 使用已验收的本地模块，不被静态源模板覆盖。
- 所有生产变更必须有先失败、后通过的自动化测试证据。

---

### Task 1: 区域边界、资源和链接契约测试

**Files:**
- Create: `frontend/next-site/__tests__/international-home-page.test.tsx`
- Create: `frontend/next-site/international-home-routing.ts`
- Test source: `frontend/public/lightvela-intl-home/index-fragment.html`

**Interfaces:**
- Produces: `shouldUseInternationalV2Home(isGlobalBuild: boolean, locale: PublicSiteLocale): boolean`
- Acceptance: global + 七个已发布 locale 返回 true；CN 和 `zh-CN` 返回 false；各 locale fragment 的正式链接和资源路径可枚举验证。

- [x] 写失败测试，断言区域选择函数、七语种 fragment、正式路由、外链安全属性和资源文件存在。
- [x] 运行 `pnpm vitest run next-site/__tests__/international-home-page.test.tsx`，确认因函数/fragment 尚不存在而 RED。
- [x] 仅实现区域选择纯函数，使边界断言 GREEN；fragment 相关断言继续 RED，证明测试覆盖接入缺口。

### Task 2: 首页结构、资源、动效和路由接入

**Files:**
- Create: `frontend/next-site/international-home-page.tsx`
- Create: `frontend/next-site/international-home-runtime.tsx`
- Create: `frontend/public/lightvela-intl-home/index-fragment.html`
- Create: `frontend/public/lightvela-intl-home/style.css`
- Create: `frontend/public/lightvela-intl-home/runtime.js`
- Create: `frontend/public/lightvela-intl-home/hero-chat.js`
- Create: `frontend/public/lightvela-intl-home/scene-wheel.js`
- Create: `frontend/public/lightvela-intl-home/assets/**`
- Modify: `frontend/src/app/(site)/page.next.tsx`
- Modify: `frontend/src/app/(site)/[lang]/page.intl.tsx`
- Modify: `frontend/next-site/__tests__/international-home-page.test.tsx`

**Interfaces:**
- Consumes: `shouldUseInternationalV2Home(...)`
- Produces: `InternationalHomePage` Server Component and `InternationalHomeRuntime` Client Component.
- Acceptance: SSR 正文存在；三段脚本只随新版首页加载并按 locale 重绑定；所有可点击元素均有正式落点；国内站与 `zh-CN` 不选择该组件。

- [x] 从已验收静态页生成无 `<script>` 的七语种 fragment，重写资源和占位链接，复制实际引用的图片与字体。
- [x] 实现 Server/Client 组件及脚本加载生命周期，接入根路由与七个国际站 locale 路由。
- [x] 运行定向测试，确认所有区域、资源和链接断言 GREEN。

### Task 3: 构建、预览和交互验收

**Files:**
- Verify: `frontend/next-site/__tests__/international-home-page.test.tsx`
- Verify: `frontend/openspec/plan.md`
- Verify: `.workflow/runtime/current-task.summary.md`

**Acceptance:**
- 定向测试无失败；`pnpm check`、国际站等价 webpack 生产构建、`git diff --check` 退出码为 0。
- 本地国际站七语种预览可打开，桌面与移动端无空白、无横向溢出、核心动效运行、关键链接跳转正确、控制台无新增错误。

- [x] 运行定向测试、`pnpm check`、国际站 webpack 生产构建和差异检查。
- [x] 启动等价 global Next 开发服务，并为验收启动 production static preview。
- [x] 使用 Browser 在桌面与移动视口完成首页、导航、CTA、语言入口和动效验收；登录后链路未执行写操作。

### Task 4: 用户验收反馈收口

**Files:**
- Modify: `frontend/next-site/international-home-runtime.tsx`
- Modify: `frontend/next-site/public-header-auth-island.tsx`
- Modify: `frontend/next-site/__tests__/public-header-auth-island.test.tsx`
- Modify: `frontend/scripts/import-international-homepage.mjs`
- Modify: `frontend/public/lightvela-intl-home/index-fragment.html`
- Modify: `frontend/public/lightvela-intl-home/style.css`
- Modify: `frontend/next-site/__tests__/international-home-rendering.test.tsx`
- Modify: `frontend/next-site/__tests__/international-home-page.test.tsx`

**Acceptance:**
- 新首页顶部右侧复用现网语言切换器和登录态账号菜单；未登录时不展示 Free trial，仅保留黑底白字 Sign In，不保留静态 `CN` / `Early Access` 动作。
- 页脚使用仓库现成透明 LightVela SVG，保持原始宽高比，不出现白底或拉伸。
- 新首页 CSS reset 仅作用于首页容器，不影响现网 Cookie 提示；Cookie 标题、正文和双按钮恢复正式站布局。
- 首页逐字标题按单词分组，移动端只在单词之间换行，不把单词拆成残缺字符。

- [x] 先补失败测试锁定现网控件挂载点、透明 SVG Logo、首页样式作用域、登录专用样式和标题换行边界。
- [x] 完成最小实现并运行 18 项定向测试、`pnpm check`、392 页 global webpack 构建与 1440×900 / 390×844 视觉回验。

### Task 5: 七语种内容、字体与动态对齐

**Acceptance:**
- 简中作为结构和动态基准，繁中四渠道动态完整对齐；其他语言使用英文版标题字体基准。
- 语言切换后 runtime、hero-chat 和 scene-wheel 重新绑定；产品标签支持悬停切换，触屏仍可点击。
- 印尼语、西语、日语、韩语 CTA 无英文回退；指定长标题桌面端保持一行，移动端无横向溢出。

- [x] 生成并接入七语种 fragment、图片和动态脚本，补齐 locale 生命周期重绑定。
- [x] 修复长标题断行、CTA 回退和繁中 WhatsApp、Telegram、Discord 动态缺失。

### Task 6: 本地模块保留与用户验收收口

**Acceptance:**
- 页脚、用户评价和 DeepSeek Harness 沿用已确认本地实现与真实多语言图片。
- 顶部只显示一个完整 LightVela 字标，不重复渲染品牌文字。
- 国际站其他公开页面的头部与首页一致，未登录时仅保留语言切换和黑色登录按钮。
- PRD、OpenSpec、自动化测试和七语种浏览器 smoke 与最终实现一致。

- [x] 按用户截图收口保留模块、首页比例、标题字体、页脚列距和 Harness 图片。
- [x] 删除顶部重复 `LightVela` 文本，并用生成测试防止回归。
- [x] 统一国际站公开页头部操作区，并校验七语种首页全部正式跳转。

## Planning Gate

**结论：通过。** 用户已明确以简中最终页面为动态基准、以英文标题字体为其他语言基准，同步国际站七个已发布首页语言并保留本地页脚、用户评价和 DeepSeek Harness；最新 master 已在独立 `frontsandbox/intl-homepage-integration` worktree；方案不依赖新接口或新依赖；影响仅限 frontend 国际站公开首页。
