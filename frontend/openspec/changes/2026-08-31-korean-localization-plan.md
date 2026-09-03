# 国际站韩语完整本地化 Implementation Plan

**Goal:** 完整交付国际站 `ko-KR` / `/ko-kr`，复用日语架构；修正浏览器验收发现的日韩高可见误译后开放生产入口。

**Architecture:** locale 注册表控制发布；UI 字典、结构化内容、Docs、法务、SEO 分别使用韩语真源；非生产国际站通过预览变量联调，生产构建忽略预览并只生成正式发布 locale。

**Tech Stack:** Next.js 16、React 19、TypeScript、i18next、Fumadocs、Vitest、Tailwind CSS、Node.js 构建脚本。

## 全局约束

- 只修改国际站韩语链路，国内站必须有负向测试。
- Models 与 Tea SDK 内嵌语言包排除。
- 先写稳定失败测试，再做最小实现；每批保留 RED/GREEN 证据。
- Docs 图片、代码块、表格、标题层级与英文源一致。
- 法务含英文优先声明，许可证正文保持英文。
- 日语、韩语高可见文案专项门禁通过后，同时开启生产 `switcherVisible` / `translationRequired`。
- commit、push、MR 需另行展示改动并取得用户明确确认。

## Tasks

- [x] **Task 1：锁定韩语发布契约和本地预览。** 为 public locale、Docs publication、SEO、HTML lang 和 `dev:global` 写失败测试；开放 `ja-JP,ko-KR` 非生产预览，证明生产与国内站仍拒绝韩语。
- [x] **Task 2：完成 2680 条韩语 UI 字典。** 增加 0 空值、占位符/HTML/换行、提示残留和固定术语测试；以英文语义底稿翻译并通过 `i18n:check`、`i18n:validate ko-KR`。
- [x] **Task 3：完成结构化内容。** 为 Soul、Buddy、人设测试、curated Skills、Experts 与场景任务写韩语 parity/resolver 测试，增加独立韩语数据源并消除中文/日语误回退。
- [x] **Task 4：完成公开页与 SEO。** 增加 `seo-data.ko.ts`，接入运行时 SEO、Next metadata、JSON-LD、canonical、hreflang、OG、sitemap 和 `html lang="ko-KR"`。
- [x] **Task 5：完成 62 篇韩语 Docs 与搜索。** 创建 `src/content/docs/ko/**`、`/api/search/ko-kr`，扩展同步脚本、Fumadocs 文案、manifest 与 parity；所有内链落在真实韩语 slug。
- [x] **Task 6：完成韩语法务。** 增加完整 Privacy/Cookie/Terms 韩语 copy、英文优先声明与 `/ko-kr` 内链；开源许可证正文保持英文并生成法务审阅清单。
- [x] **Task 7：完成字体、切换器与浏览器验收。** 增加韩语系统字体栈，证明不进入字体子集；运行桌面/移动端首页、Docs、法务和核心 Agent smoke，检查 console、缺字与溢出。
- [x] **Task 8：执行日韩需求专项质量门禁。** 运行定向 Vitest、Docs parity/sync、`pnpm check`、国际/国内生产构建和 `git diff --check`；仓库全量测试中的无关历史失败不纳入本需求。

> 当前状态：日韩需求实现与专项验收完成；等待用户验收，不自动 commit、push 或创建 MR。

## 2026-08-31 截图回归修复

- [x] **Task 8.1：修复非中文 locale 的模型元数据与系统默认名称。** 修改 `src/pages/marketing/agent-provider-locale.ts`、`src/pages/marketing/agent-settings-page.tsx` 和对应测试；日语、韩语、印尼语与西语统一读取七彩石英文 provider 数据，后端默认名 `我的Hermes` 经当前 locale 的 `t(...)` 展示，自定义名称保持原样。
- [x] **Task 8.2：修复 AgentChat 默认会话标题。** 在同一 locale 边界增加纯函数和测试；仅当 SDK 返回精确系统默认值 `新会话` 且当前为非中文 locale 时展示 `New chat`，用户历史消息和自定义会话标题不做翻译。
- [x] **Task 8.3：修复长文案布局。** 修改 `src/styles.css` 与 `src/components/site/legal-footer.tsx`，补充 CSS/组件回归测试；套餐提醒允许在侧栏可用宽度内完整换行，二维码说明取消 `nowrap` 并在受限宽度内居中换行。
- [x] **Task 8.4：验证。** 运行相关 Vitest、`pnpm check`、`git diff --check`，并在日语模型页、日语账号页和韩语聊天页做浏览器回归；登录态实页因本地认证服务不可用被记录为 blocked，默认会话标题由自动化测试覆盖。

## 2026-08-31 生产入口开放决策

- [x] **Task 9.1：测试先行锁定高可见文案。** 为浏览器发现的日语 Blog、News digest、Coding Plan、24/7、页脚，以及韩语 Docs、Free Trial、News digest、Hydration reminder、自托管说明、首页 CTA 等增加语义断言。
- [x] **Task 9.2：开放日韩入口。** 同时把 `ja-JP`、`ko-KR` 的 `switcherVisible` 与 `translationRequired` 设为 `true`，更新生产路由、Docs 和切换器测试；国内构建仍不得生成 `/ja-jp/**` 或 `/ko-kr/**` 页面。
- [x] **Task 9.3：最终专项验收。** 完成日韩桌面端/移动端首页、Docs、法务页和可达 Agent 页面验收，并生成截图与 HTML 报告。

> 产品决定：法务内容沿用西语做法，保留完整本地化译文及“发生歧义时以英文版本为准”的说明；用户安排日韩母语和法务人员后续复核，但不作为本次代码入口开放的阻塞项。Docs 图片体积不在本需求范围。

## 主要验证命令

```bash
pnpm exec vitest run --config vitest.config.ts \
  src/i18n/__tests__/dictionaries.test.ts \
  src/i18n/__tests__/locales.config.test.ts \
  next-site/__tests__/public-locale.test.ts \
  next-site/__tests__/docs-route-publication.test.ts \
  next-site/seo.test.ts
node scripts/i18n-validate.mjs ko-KR
pnpm exec vitest run --config vitest.config.ts scripts/international-docs-parity.test.ts
pnpm check
pnpm build:global
pnpm build:cn
git diff --check
```
