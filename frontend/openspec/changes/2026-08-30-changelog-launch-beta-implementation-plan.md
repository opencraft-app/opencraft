# Changelog Launch And Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更新国内/国际 Changelog 的 DeepSeek Harness Beta 标识与自动任务测试运行动态，准确记录双站产品阶段，并在国际站 8 月补充印度尼西亚语支持和正式付费上线节点。

**Architecture:** 保持 `changelog-page.tsx` 现有数据驱动结构和可选 `badge` 字段；区域差异继续通过编译期 `isGlobal` 分支表达。双站 4 月统一复用公测翻译键；国际站 8 月在现有数组末尾追加两个无图条目，且不影响中国站既有 7 月正式上线节点。

**Tech Stack:** React 19、TypeScript、Tailwind CSS、Vitest、Testing Library、项目字面量 i18n。

## Global Constraints

- DeepSeek Harness 国内站标题必须为 `LightVela 实验室新增 DeepSeek Harness`，标题右侧必须显示 `Beta`。
- 国内站 7 月最后一条标题必须为 `LightVela 正式上线并启用付费服务`。
- 国内站 7 月描述必须逐字为 `LightVela 产品中国站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。`
- 国内站 7 月正式上线条目不配图，国际站不显示该条目。
- 双站 4 月均使用源标题 `LightVela 产品公测上线`；国际站按当前语言显示其 Public Beta 本地化标题。
- 不替换现有 Changelog 图片，不修改其他月份内容或业务逻辑。
- 自动任务测试运行条目必须位于国内站和国际站 8 月更新日志的 DeepSeek Harness 条目之后，并使用 `visual: "none"`。
- 国内站标题必须为 `自动任务支持测试运行`，描述必须逐字为 `创建或编辑自动任务时，可以先运行一次当前任务内容，无需保存即可确认执行效果，再决定是否创建或更新任务。`。
- 国际站英文标题必须为 `Jobs Now Support Test Runs`，描述必须为 `When creating or editing a job, you can run the current job once without saving it, review the result, and then decide whether to create or update the job.`。
- 国际站 8 月倒数第二条必须为印度尼西亚语支持动态，最后一条必须为正式上线并启用付费服务动态；两条均使用 `visual: "none"`。
- 国际站 8 月新增条目覆盖当前可见语言 `en-US`、`zh-CN`/`zh-SG`、`zh-Hant`、`id-ID`、`es`；`ja-JP`、`ko-KR` 只维护键结构，不补充对外翻译。
- 国际站正式上线描述必须与中国站 7 月描述使用不同翻译键，避免把“中国站”或“国际站”错误复用到另一站点。
- 中国站 8 月内容和其他月份内容保持不变，不显示国际站印度尼西亚语支持动态或国际站正式上线描述。

---

### Task 1: 用区域回归测试锁定文案、顺序与 Beta 标签

**Files:**
- Modify: `src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `src/pages/marketing/__tests__/global-changelog.test.tsx`

**Interfaces:**
- Consumes: `ChangelogPage` 的现有月份 section、heading、article 和图片语义。
- Produces: 国内/国际区域行为的失败测试，约束后续最小实现。

- [x] **Step 1: 增加国内站失败测试**

  在国内站测试中断言 DeepSeek 标题包含实验室归属和 `Beta` 标签；7 月 section 的最后一个 heading 为正式上线条目、描述精确匹配且该 article 不含图片；4 月显示公测标题且不再显示内测标题。

- [x] **Step 2: 增加国际站失败测试**

  在国际站中文和英文渲染中断言 DeepSeek 本地化标题与 `Beta`；断言国际站不存在国内站正式上线条目和描述；英文 4 月标题仍为 `LightVela Product Beta Launch`。

- [x] **Step 3: 运行测试确认 RED**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 新增断言因旧标题、缺少 badge 和缺少 7 月条目而失败；既有断言继续通过。

### Task 2: 最小实现 Changelog 数据与标题标签

**Files:**
- Modify: `src/pages/marketing/changelog-page.tsx`
- Modify: `src/i18n/generated/*.json`（仅通过仓库 i18n 脚本生成和补齐翻译）

**Interfaces:**
- Consumes: `ChangelogEntry`、`isGlobal`、`useT()` 和 `visual: "none"`。
- Produces: `badge?: string` 字段、区域化 4 月标题、国内站 7 月无图条目和 DeepSeek Beta 标题。

- [x] **Step 1: 增加可选 badge 并渲染语义化标签**

  为 `ChangelogEntry` 增加 `badge?: string`，在 `h2` 内用无交互 `span` 渲染紧凑的 `Beta` 胶囊标签。

- [x] **Step 2: 更新三个产品节点**

  同步更新国内/国际 DeepSeek 条目标题并设置 `badge: "Beta"`；在国内站 7 月数组末尾追加 `visual: "none"` 的正式上线条目；4 月标题按 `isGlobal` 保留国际旧键、国内使用公测新键。

- [x] **Step 3: 生成并补齐 i18n**

  Run: `pnpm i18n:extract`

  为新 DeepSeek 标题提供英语、繁体中文、印尼语和现有受支持语言翻译；运行 `pnpm i18n:zh-hant` 生成繁体中文文案，禁止手工编造哈希键。

- [x] **Step 4: 运行定向测试确认 GREEN**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 两个测试文件全部通过。

### Task 3: 完成质量与双站页面验证

**Files:**
- Verify: `src/pages/marketing/changelog-page.tsx`
- Verify: `src/pages/marketing/__tests__/channel-copy.test.tsx`
- Verify: `src/pages/marketing/__tests__/global-changelog.test.tsx`
- Verify: `src/i18n/generated/*.json`

**Interfaces:**
- Consumes: Task 2 的最终实现。
- Produces: 可提交前的自动化与页面验收证据。

- [x] **Step 1: 运行静态门禁**

  Run: `pnpm i18n:check && pnpm i18n:zh-hant:check && pnpm check`

  Expected: 命令成功，且无新增 TypeScript 或 i18n 错误。

- [x] **Step 2: 运行差异检查**

  Run: `git diff --check && git status --short`

  Expected: 无空白错误，改动仅包含计划、Changelog 页面、定向测试和必要 i18n 资源。

- [x] **Step 3: 浏览器验证国内和国际页面**

  国内站确认 DeepSeek 实验室标题与 Beta、7 月最后一条无图、4 月公测标题；国际站确认本地化 DeepSeek Beta、没有国内付费条目、4 月英文 Beta 标题保持不变。

- [ ] **Step 4: 等待提交授权**

  展示 scoped diff、验证结果和建议提交信息；未经用户确认不执行 commit、push 或 MR。

### Task 4: 在双站 8 月动态增加自动任务测试运行条目

**Files:**
- Modify: `src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `src/pages/marketing/changelog-page.tsx`
- Modify: `src/i18n/generated/*.json`（仅通过仓库 i18n 脚本生成和补齐翻译）

**Interfaces:**
- Consumes: 国内站和国际站各自的 `2026-08` 条目数组、现有 `visual: "none"`、`useT()` 字面量翻译链路。
- Produces: 双站 8 月最后一条无图测试运行动态，以及中文、英文和现有受支持语言的本地化文案。

- [x] **Step 1: 写失败测试锁定双站文案、顺序与无图状态**

  国内站断言 8 月最后一个 `article` 的标题为 `自动任务支持测试运行`，描述逐字匹配确认文案，且该条目中不存在 `img`。国际站中文渲染断言同一条目存在并位于 8 月末尾；英文渲染断言标题为 `Jobs Now Support Test Runs`、描述为已确认英文文案，并且条目不含图片。

- [x] **Step 2: 运行 Changelog 定向测试确认 RED**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 新增测试因测试运行条目尚不存在而失败；既有断言继续通过。

- [x] **Step 3: 最小实现双站 8 月无图条目**

  在 `changelog-page.tsx` 的国内站和国际站 `2026-08` 数组末尾分别追加相同条目：`id: "automation-form-test-run"`、确认后的标题和描述，以及 `visual: "none" as const`。不新增视觉 variant，不修改自动任务业务逻辑。

- [x] **Step 4: 生成并补齐本地化资源**

  Run: `pnpm i18n:extract && pnpm i18n:zh-hant`

  为新标题和描述补齐英语、繁体中文、印尼语、西班牙语等必填语言；英语必须使用 Global Constraints 中的 Title Case 标题和确认描述。禁止手工编造哈希键。

- [x] **Step 5: 运行定向测试确认 GREEN**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 两个测试文件全部通过，双站既有 8 月条目和区域差异保持不变。

- [x] **Step 6: 完成质量与双站浏览器验证**

  Run: `pnpm i18n:check && pnpm i18n:zh-hant:check && pnpm check && git diff --check`

  国内站 `/changelog/` 与国际站 `/en-us/changelog/` 均确认该条目位于 8 月末尾、文案正确且无图；移动端不新增横向溢出。

  Evidence: Changelog 定向测试 RED 时 2 个新增断言失败、11 个既有用例通过；GREEN 后 13/13 通过。`pnpm i18n:check`、`pnpm i18n:zh-hant:check`、`pnpm check` 与 `git diff --check` 通过。浏览器确认国内/国际 8 月最后一条均为测试运行且无图；新增国际站条目在 390px 下 `clientWidth = scrollWidth = 342`，未引入横向溢出。页面顶部英文说明存在既有 390px 溢出，不属于本任务范围。

- [x] **Step 7: 展示差异并等待提交授权**

  汇总 scoped diff、RED/GREEN、i18n/类型检查和双站浏览器证据；未经用户确认不执行 commit、push 或更新 MR !3458。

### Task 5: 调整测试运行条目的位置和描述

**Files:**
- Modify: `src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `src/pages/marketing/changelog-page.tsx`
- Modify: `src/i18n/generated/*.json`（仅通过仓库 i18n 脚本生成和补齐翻译）

**Interfaces:**
- Consumes: 双站 `2026-08` 条目数组与现有 `automation-form-test-run` 条目。
- Produces: 双站均紧接 DeepSeek Harness 的测试运行动态，以及更新后的本地化描述。

- [x] **Step 1: 写失败测试锁定紧邻顺序和新文案**

  国内站、国际站中文和国际站英文测试均断言测试运行条目紧接 DeepSeek Harness；中文描述使用“当前任务内容”，英文描述同步使用 `current job`。

- [x] **Step 2: 运行定向测试确认 RED**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 当前实现因条目仍位于 8 月末尾且描述仍为旧文案而失败。

- [x] **Step 3: 最小调整双站数组与源文案**

  将两个 `automation-form-test-run` 条目移动到各自 DeepSeek Harness 条目后，只替换确认后的描述，不修改其他条目、图片或业务逻辑。

- [x] **Step 4: 重新生成本地化资源并补齐语义更新**

  Run: `pnpm i18n:extract && pnpm i18n:zh-hant`

  更新英语、繁体中文、印尼语、西班牙语等资源；禁止手工编造哈希键。

- [x] **Step 5: 完成 GREEN 和完整质量门禁**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1 && pnpm i18n:check && pnpm i18n:zh-hant:check && pnpm check && git diff --check`

  Expected: 定向测试和全部门禁通过，差异仅包含计划、Changelog 数据、测试与必要 i18n 资源。

  Evidence: RED 时两个区域测试各有 1 个顺序断言按预期失败，其余 11 个用例通过；最小实现后 13/13 GREEN。`pnpm i18n:check`、`pnpm i18n:zh-hant:check`、`pnpm check` 和 `git diff --check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new / 69 resolved。

### Task 6: 国际站公测、正式付费上线与印度尼西亚语支持

> Task 1-5 记录的是此前已完成阶段及当时的验收基线；本任务以最新确认方案为准，并替代其中“国际站 4 月保留 Product Beta”的旧阶段结论。

**Files:**
- Modify: `src/pages/marketing/__tests__/channel-copy.test.tsx`
- Modify: `src/pages/marketing/__tests__/global-changelog.test.tsx`
- Modify: `src/pages/marketing/changelog-page.tsx`
- Modify: `src/i18n/generated/en-US.json`
- Modify: `src/i18n/generated/es.json`
- Modify: `src/i18n/generated/id-ID.json`
- Modify: `src/i18n/generated/zh-CN.json`
- Modify: `src/i18n/generated/zh-Hant.json`
- Verify: `src/i18n/generated/ja-JP.json`
- Verify: `src/i18n/generated/ko-KR.json`

**Interfaces:**
- Consumes: `ChangelogPage` 的 `isGlobal` 月份数组、`useT()` 字面量翻译、现有 `visual: "none"` 和可见语言注册表。
- Produces: 双站 4 月 Public Beta 标题、国际站 8 月倒数第二条印度尼西亚语支持动态、最后一条正式付费上线动态，以及五套可见字典的完整本地化。

- [x] **Step 1: 写失败测试锁定双站边界、语言和顺序**

  在 `global-changelog.test.tsx` 中使用当前字典依次渲染简体中文、繁体中文、英语、印尼语和西班牙语，断言：

  - 4 月标题使用各语言的 Public Beta 文案，不出现旧的 Product Beta / 内测标题。
  - 8 月存在印度尼西亚语支持与正式付费上线两个条目。
  - 8 月最后两个 heading 的顺序固定为“印度尼西亚语支持 → 正式付费上线”。
  - 两个新增 `article` 均不包含 `img`，正式付费上线是 8 月最后一个条目。

  在 `channel-copy.test.tsx` 中断言中国站不出现源描述 `LightVela 国际站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。`，也不出现 `LightVela 支持印度尼西亚语`。

- [x] **Step 2: 运行 Changelog 定向测试确认 RED**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 新增国际站断言因 8 月两个条目尚不存在、4 月仍使用旧内测源键而失败；既有 13 个测试继续通过。

- [x] **Step 3: 最小实现双站 4 月公测与国际站 8 月两个无图条目**

  在 `changelog-page.tsx` 中把 4 月标题从区域条件改为统一翻译键：

  ```tsx
  title: t("LightVela 产品公测上线"),
  ```

  仅在 `isGlobal` 的 `2026-08` 数组末尾按以下顺序追加：

  ```tsx
  {
    id: "indonesian-language",
    title: t("LightVela 支持印度尼西亚语"),
    description: t(
      "现在可以使用印度尼西亚语浏览 LightVela 的公开页面、产品文档和账号流程。",
    ),
    visual: "none" as const,
  },
  {
    id: "global-official-launch",
    title: t("LightVela 正式上线并启用付费服务"),
    description: t(
      "LightVela 国际站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。",
    ),
    visual: "none" as const,
  },
  ```

  不移动中国站条目，不新增图片、视觉 variant、路由或业务逻辑。

- [x] **Step 4: 生成翻译键并补齐所有可见语言**

  Run: `pnpm i18n:extract && pnpm i18n:zh-hant`

  对脚本生成的新键写入以下精确翻译，禁止手工编造哈希键：

  - `en-US`：`Indonesian Is Now Available` / `Browse LightVela's public pages, documentation, and account flows in Indonesian.`；`LightVela Officially Launches with Paid Services` / `LightVela is now officially available globally with paid services. Choose a subscription plan that fits your needs.`
  - `zh-Hant`：`LightVela 支持印度尼西亞語` / `現在可以使用印度尼西亞語瀏覽 LightVela 的公開頁面、產品文檔和賬號流程。`；`LightVela 正式上線並啓用付費服務` / `LightVela 國際站正式上線，同步啓用付費服務。你可以根據使用需求選擇合適的訂閲套餐。`
  - `id-ID`：`Bahasa Indonesia Kini Tersedia` / `Sekarang Anda dapat menjelajahi halaman publik, dokumentasi produk, dan alur akun LightVela dalam Bahasa Indonesia.`；`LightVela Resmi Diluncurkan dengan Layanan Berbayar` / `LightVela kini resmi tersedia secara global dengan layanan berbayar. Pilih paket langganan yang sesuai dengan kebutuhan Anda.`
  - `es`：`El indonesio ya está disponible` / `Ahora puedes explorar las páginas públicas, la documentación del producto y los flujos de cuenta de LightVela en indonesio.`；`LightVela se lanza oficialmente y activa los servicios de pago` / `LightVela ya está disponible oficialmente a nivel global con servicios de pago. Elige el plan de suscripción que mejor se adapte a tus necesidades.`
  - `zh-CN` 保持源文案；`zh-SG` 复用 `zh-CN`。`ja-JP` 和 `ko-KR` 只保留提取脚本生成的空值结构。

- [x] **Step 5: 运行定向测试确认 GREEN**

  Run: `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx --api.host 127.0.0.1`

  Expected: 两个测试文件全部通过；国际站五种可见语言的 Public Beta、印度尼西亚语支持和正式付费上线文案均通过断言，中国站排除断言保持通过。

- [x] **Step 6: 运行完整前端质量门禁**

  Run: `pnpm i18n:check && pnpm i18n:zh-hant:check && pnpm check && git diff --check`

  Expected: i18n 结构、繁体生成、TypeScript、Lint 和差异检查全部通过；改动范围仅包含设计/计划、Changelog 页面、定向测试和必要的生成字典。

- [x] **Step 7: 浏览器验证中国站和国际站可见语言**

  分别启动 `VITE_REGION=cn` 和 `VITE_REGION=global` 本地预览，检查：

  - 中国站 `/changelog/`：4 月为公测，且不出现国际站两个新增 8 月条目。
  - 国际站 `/changelog/`、`/zh-sg/changelog/`、`/zh-hant/changelog/`、`/id-id/changelog/`、`/es/changelog/`：4 月均为 Public Beta；8 月倒数第二条为印度尼西亚语支持，最后一条为正式付费上线；两条均无图。
  - 桌面端和 390px 移动端不因新增条目引入横向溢出。

- [x] **Step 8: 展示差异并等待提交授权**

  汇总 scoped diff、RED/GREEN、i18n/类型/差异门禁和双站浏览器证据；提交信息建议为 `更新国际站产品阶段与语言动态 / feat(changelog): add global launch milestones`。未经用户明确确认不执行 commit、push 或创建后续 MR。

  Evidence: 基线为 13/13；RED 时新增 2 个国际站用例失败、既有 13 个用例通过；最小实现及公测图片辅助文本同步后 15/15 GREEN。`pnpm i18n:check`、`pnpm i18n:zh-hant:check`、`pnpm check` 与 `git diff --check` 通过，TypeScript diagnostics 为 207 current / 276 baseline / 0 new / 69 resolved。浏览器确认中国站只显示中国站节点，国际站英文、简中、繁中、印尼语和西语均显示 Public Beta，且 8 月最后两条顺序与无图状态正确；西语 390px 下两个新增 article 均为 `clientWidth = scrollWidth = 342`。页面整体存在既有公共区域横向溢出，本地跨语言导航还会记录既有鉴权/水合日志，本任务未引入新的目标条目错误。用户已明确要求代码完成后提交 MR；远端核验发现 MR !3458 已合并，因此改为创建只包含本次差异的后续 MR。
