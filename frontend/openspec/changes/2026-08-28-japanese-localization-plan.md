# 国际站日语完整本地化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The repository is configured for single-agent execution; do not dispatch subagents.

**Goal:** 完整交付国际站日语版本，并在自动门禁、母语抽检和法务全文审阅前保持发布入口受控。

**Architecture:** 以 locale 注册表为发布真源，把西语专属分支收敛为 locale-indexed resolver；日语内容分 UI 字典、结构化数据、Docs、法务和 SEO 五条可独立验证的管线。所有静态路由和 metadata 只从已发布 locale 派生，最终用单一注册表开关开放 `/ja-jp/**`。

**Tech Stack:** Next.js 16、React 19、TypeScript 5.9、i18next、Fumadocs、Vitest、Tailwind CSS v4、Node.js i18n/SEO 构建脚本。

## Global Constraints

- 只作用于国际站；国内站必须有负向测试并保持零用户可见变化。
- `ja-JP` / `/ja-jp` 为唯一 locale 与 URL 前缀，不新增别名。
- Models 与 Tea SDK 内嵌区域不在本次本地化范围。
- 业务字典通过中文原文映射写入，不直接根据 hash 编辑。
- Docs 图片目标、代码块、标题层级、表格结构与英文源一致。
- 法务页面必须包含英文版本优先说明；许可证正文保持英文。
- 不新增动画、交互原语、重型运行时依赖或完整日韩 WebFont。
- commit、push 和 MR 必须在展示内容并取得用户确认后执行。

---

### Task 1: 日语发布契约与 locale resolver

**Files:**
- Modify: `src/i18n/__tests__/locales.config.test.ts`
- Modify: `src/i18n/__tests__/dictionaries.test.ts`
- Modify: `next-site/__tests__/public-locale.test.ts`
- Modify: `next-site/seo.test.ts`
- Modify: `scripts/international-docs-parity.test.ts`
- Modify: `src/i18n/locales.config.ts`
- Modify: `next-site/public-locale.ts`
- Modify: `next-site/seo.tsx`

**Interfaces:**
- Consumes: `LOCALE_DEFINITIONS`, `SWITCHER_VISIBLE_LOCALES`, `TRANSLATION_REQUIRED_DICT_KEYS`.
- Produces: 发布 locale 派生集合，供路由、SEO、Docs 与字体管线使用。

- [x] **Step 1: 写失败测试，要求日语发布后进入切换器、静态路由、SEO 和 Docs 集合，同时国内站不出现日语入口。**
- [x] **Step 2: 运行定向测试并确认失败原因为日语仍隐藏且发布数组硬编码排除 `ja-jp`。**

  Run:
  ```bash
  pnpm exec vitest run --config vitest.config.ts src/i18n/__tests__/locales.config.test.ts next-site/__tests__/public-locale.test.ts next-site/seo.test.ts
  ```

- [x] **Step 3: 将发布数组与 locale resolver 改为注册表派生，保留日语最终开关到 Task 8。**
- [x] **Step 4: 运行同一组测试，除明确等待日语开关的断言外全部通过。**

### Task 2: 2654 条日语 UI 字典

**Files:**
- Modify: `src/i18n/generated/ja-JP.json`
- Create: `src/i18n/__tests__/fixtures/ja-JP-terminology.json`
- Modify: `src/i18n/__tests__/dictionaries.test.ts`
- Modify: `scripts/i18n-validate.mjs`

**Interfaces:**
- Consumes: `zh-CN.json`, `en-US.json`, `zh-to-key.json`, `scripts/i18n-apply.mjs`.
- Produces: key 集与中文基准一致、结构安全的完整 `ja-JP` resource。

- [x] **Step 1: 写失败测试，要求日语 2654/2654 非空、无大段中文、占位符/HTML/换行结构与中文基准一致，并验证固定术语。**
- [x] **Step 2: 运行字典测试与 `node scripts/i18n-validate.mjs ja-JP`，记录缺失 2651 条的 RED 证据。**
- [x] **Step 3: 以英文译文为语义底稿生成日语初译，保护品牌、命令、变量、标签和代码；通过中文原文映射应用到字典。**
- [x] **Step 4: 修正结构校验、术语和高频 UI 文案，直到字典测试与日语 validate 全绿。**

### Task 3: Soul、Skills、Experts 与场景任务结构化内容

**Files:**
- Create: `src/lib/soul-japanese-data.ts`
- Create: `src/lib/soul-japanese-data.test.ts`
- Create: `src/pages/marketing/agent-buddy-soul-test-data.ja.ts`
- Create: `src/pages/marketing/__tests__/agent-buddy-soul-test-data.ja.test.ts`
- Create: `src/pages/marketing/skills-demo/curated-skill-overviews.ja.ts`
- Modify: `src/pages/marketing/skills-demo/curated-skill-overviews.ts`
- Modify: `src/pages/marketing/agent-buddy-panel.tsx`
- Modify: `src/pages/marketing/agent-buddy-soul-test-modal.tsx`
- Modify: `src/pages/marketing/agent-buddy-draw-modal.tsx`
- Modify: `src/pages/marketing/agent-experts-panel.tsx`
- Modify: `src/pages/marketing/agent-skills-panel.tsx`
- Modify: `src/pages/marketing/scenario-tasks/scenario-packs.ts`
- Modify: `src/pages/marketing/scenario-tasks/scenario-task-builder.ts`

**Interfaces:**
- Consumes: 英文 Soul/Skills/场景结构与 locale code。
- Produces: `ja-JP` 结构化数据 resolver，发布后不得回退中文或西语。

- [x] **Step 1: 写失败测试，锁定日语数据数量、slug/id parity、无中文串用和 resolver 选择。**
- [x] **Step 2: 运行结构化内容专项测试，确认 RED 来自缺少日语模块和西语专属分支。**
- [x] **Step 3: 增加日语数据源并把分支收敛为 locale-indexed resolver；API 不支持日语时显式使用英文请求语言，但 UI 使用日语。**
- [x] **Step 4: 运行 Soul、Buddy、Skills、Experts、场景任务测试，确认日语内容与英文结构等长。**

完成证据：Soul 16/16、人设测试 15/15、偏好标签 8/8、精选 Skills 30/30、场景任务 6/6 已完成；Experts 在日语 UI 下显式请求英文 API 内容。11 个专项文件共 200 个测试通过，类型基线 0 new。

### Task 4: 公开页、SEO、metadata 与 JSON-LD

**Files:**
- Create: `src/lib/seo-data.ja.ts`
- Create: `src/lib/seo-data.ja.test.ts`
- Modify: `src/lib/seo-data.ts`
- Modify: `next-site/seo.tsx`
- Modify: `next-site/seo.test.ts`
- Modify: `src/app/sitemap.xml/route.next.ts`
- Modify: `scripts/check-next-seo.test.ts`
- Modify: `scripts/fix-next-static-html-lang.test.ts`
- Modify: `next-site/public-pages.tsx`
- Modify: `next-site/legal-pages.tsx`

**Interfaces:**
- Consumes: `ja-JP` locale definition、真实 public/docs slug。
- Produces: 日语 title/description/keywords、canonical、hreflang、sitemap、OG 和 JSON-LD。

- [x] **Step 1: 写失败测试，要求 `/ja-jp/**` metadata 自洽且只收录真实 200 路由。**
- [x] **Step 2: 运行 SEO、sitemap、HTML lang 测试并确认 RED 来自日语仍是占位 SEO 数据。**
- [x] **Step 3: 增加日语 SEO 数据并把 SoftwareApplication JSON-LD 改为 locale record，移除西语单例分支。**
- [x] **Step 4: 运行 metadata 测试，确认 title、description、canonical、og:url、og:locale 与 hreflang 同源。**

完成证据：日语公开页、Docs 和产品页 SEO 数据已补齐；SoftwareApplication 描述改为 8 locale 穷举 record；公开、前缀、Docs 与跨站 hreflang 集合均由发布注册表和实际 Docs manifest 共同派生。SEO/metadata 39 个测试、sitemap/静态 SEO 18 个测试通过，类型基线 0 new；日语发布标记仍关闭。

### Task 5: 61 篇日语 Docs 与搜索

**Files:**
- Create: `src/content/docs/ja/**/*.md`（与 `src/content/docs/es/**/*.md` 61 个文件同集合）
- Create: `src/app/api/search/ja-jp/route.next.ts`
- Modify: `scripts/international-docs-parity.test.ts`
- Modify: `scripts/sync-fumadocs-content.mjs`
- Modify: `next-site/docs-route-manifest.ts`

**Interfaces:**
- Consumes: `src/content/docs/en/**`、Docs sidebar/slug 注册和 locale definition。
- Produces: `/ja-jp/docs/**` 正文、搜索索引、manifest 与 metadata。

- [x] **Step 1: 写失败 parity，锁定 61 个文件、图片目标、代码块、标题层级、表格和真实内链集合。**
- [x] **Step 2: 运行 Docs parity，确认 RED 来自 `src/content/docs/ja` 和日语 search route 缺失。**
- [x] **Step 3: 第一批翻译 Getting Started、Plans、Features、Support，并运行 `pnpm docs:sync` 与 parity。**
- [x] **Step 4: 第二批翻译 Use Cases，检查模板、表格、事实、渠道顺序和日语内链。**
- [x] **Step 5: 第三批翻译 Compare 与 Hermes Agent，检查实体表达、GEO 可抽取性和代码块。**
- [x] **Step 6: 生成搜索路由与 manifest，确认 61 个日语 slug 全部读取 `src/content/docs/ja`。**

完成证据：`src/content/docs/ja` 与英文 61/61 文件等集，图片、链接、代码块、标题、表格和列表结构逐篇一致；生成 61 个 MDX 与 62 条 `ja-jp` manifest 路由，全部 source_path 指向日语源。日语搜索端点、侧边栏、面包屑、更新时间和 Fumadocs 控件已接入；35 个 Docs 专项测试、类型基线和 diff 检查通过。公开路由门禁仍保持关闭。

### Task 6: 日语法务页面

**Files:**
- Create: `src/pages/marketing/legal-copy.ja.ts`
- Modify: `src/pages/marketing/privacy-policy-page.tsx`
- Modify: `src/pages/marketing/cookie-policy-page.tsx`
- Modify: `src/pages/marketing/terms-of-service-page.tsx`
- Modify: `src/pages/marketing/open-source-licenses-page.tsx`
- Modify: `src/pages/marketing/__tests__/legal-page-routing.test.ts`

**Interfaces:**
- Consumes: 英文法务结构与日语 locale。
- Produces: 完整日语 privacy/cookie/terms copy；许可证正文继续使用英文。

- [x] **Step 1: 写失败测试，锁定段落/表格数量 parity、英文优先说明、内部链接和许可证原文边界。**
- [x] **Step 2: 运行法务测试，确认 RED 来自日语 fallback 英文。**
- [x] **Step 3: 增加日语法务 copy 与 locale resolver，保持结构和链接 token 不变。**
- [x] **Step 4: 运行法务测试并生成全文人工审阅清单；审阅未确认前不得合入发布。**

完成证据：日语 Privacy/Cookie/Terms 完整结构、英文优先声明与 `/ja-jp` 法务内链已接入；利用规约保留英文正式文本 453 块并增加 2 个日语语言声明块。Open Source 只翻译页面结构，许可证正文原样英文。9 个法务专项测试、类型基线和 diff 检查通过；`2026-08-28-japanese-legal-review-checklist.md` 仍待母语法务签署，发布门禁保持关闭。

### Task 7: 日语字体、语言切换器与性能

**Files:**
- Modify: `src/styles.css`
- Modify: `scripts/subset-fonts.test.ts`
- Modify: `src/components/site/__tests__/language-switcher.test.tsx`
- Modify: `src/components/site/language-switcher.tsx`（仅在测试证明布局需要时）

**Interfaces:**
- Consumes: `<html lang="ja-JP">` 与现有语言切换器。
- Produces: 日语系统字体栈、无缺字方块且不溢出的切换器。

- [x] **Step 1: 写失败测试，要求日语使用系统字体回退且不进入 HY 子集；切换器保留 ARIA 与键盘语义。**
- [x] **Step 2: 运行字体和切换器测试，确认 RED 来自缺少日语 CSS。**
- [x] **Step 3: 增加日语 font variables 与 `html[lang="ja-JP"]` 覆盖，不新增动画或 WebFont。**
- [x] **Step 4: 运行定向测试并比较国际站构建前后 gzip JS；超过 100 KB 或 10% 才实施字典懒加载。**

完成证据：locale 注册表新增 `fontSubsetEligible`，确保日语/韩语即使发布也不进入 HY 子集，西语仍保留源字体支持的重音字符；日语使用 Hiragino Sans / Yu Gothic / Noto Sans JP / system-ui，未新增 WebFont。语言切换器保留 listbox/option ARIA，并支持方向键打开、选项焦点、Escape 关闭回焦。字体、切换器与初始 locale 共 44 个专项测试通过。同步装载日语时首页 gzip JS 相对基线增加 111,593 bytes（+8.05%），触发 >100 KB 门禁；改为日语/韩语字典按 locale 动态加载并补齐 SSR/Provider 预载后，最终首页 gzip 为 1,347,078 bytes，相对基线减少 39,334 bytes（-2.84%）。国际站生产构建、SEO 检查、类型基线与 diff 检查通过。

### Task 8: 开放日语并完成整体验证

**Files:**
- Modify: `src/i18n/locales.json`
- Modify: `src/i18n/__tests__/locales.config.test.ts`
- Modify: `scripts/international-docs-parity.test.ts`
- Modify: `openspec/plan.md`

**Interfaces:**
- Consumes: Tasks 1–7 的全绿证据和 A1 审阅清单。
- Produces: 可通过 `/ja-jp/**` 访问的完整日语版本。

- [ ] **Step 1: 运行发布前全量门禁，确认日语字典、结构化内容、Docs、法务、SEO 和字体无缺口。**

  Run:
  ```bash
  pnpm i18n:check
  pnpm i18n:validate -- ja-JP
  pnpm test
  pnpm check
  pnpm build:global
  ```

  当前证据：审查提出的 4 个 Important（隐藏语言绕过、真实路由 metadata、Docs 发布开关、Cookie/Support 非字典文案）均已按测试先行修复；23 个本次变更测试文件共 333 项通过，另有 109 个 SSR/Provider 回归和 48 个 Docs/区域路由测试通过。`i18n:check`、日语 validate（0 error）、`pnpm check`、类型基线、国际/国内生产构建和 diff 检查通过；国际站 388 路由保持 `/ja-jp/**` 隐藏，国内站 88 路由不包含日语页面或搜索端点。全量 `pnpm test` 仍受仓库既有模型配置卡住及 Docs 图片、9 篇非日语摘要、MDX、印尼续费等失败阻断，因此本 Step 保持未完成；日语新增失败已清零。

- [ ] **Step 2: 将 `ja-JP.switcherVisible` 与 `translationRequired` 同时设为 `true`，更新隐藏态测试为发布态测试。**
- [ ] **Step 3: 重新运行全量门禁和 `git diff --check`，确认国内站负向断言仍通过。**
- [ ] **Step 4: 在本地国际站对 `/ja-jp/`、Docs、法务和 `/agents` 做桌面/移动端 smoke，记录 console 与缺字结果。**
- [ ] **Step 5: 输出母语抽检清单、法务全文审阅清单、变更范围和验证证据；等待用户验收，不执行 commit/push/MR。**
