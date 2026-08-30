# Changelog Launch And Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更新国内/国际 Changelog 的 DeepSeek Harness Beta 标识，并准确记录国内站公测、正式上线和付费服务节点。

**Architecture:** 保持 `changelog-page.tsx` 现有数据驱动结构，为条目增加可选 `badge` 字段；区域差异继续通过编译期 `isGlobal` 分支表达。国内站 7 月新增无图条目，4 月标题按区域选择，国际站不引入国内付费节点。

**Tech Stack:** React 19、TypeScript、Tailwind CSS、Vitest、Testing Library、项目字面量 i18n。

## Global Constraints

- DeepSeek Harness 国内站标题必须为 `LightVela 实验室新增 DeepSeek Harness`，标题右侧必须显示 `Beta`。
- 国内站 7 月最后一条标题必须为 `LightVela 正式上线并启用付费服务`。
- 国内站 7 月描述必须逐字为 `LightVela 产品国内站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。`
- 国内站 7 月正式上线条目不配图，国际站不显示该条目。
- 国内站 4 月标题必须为 `LightVela 产品公测上线`；国际站继续显示 `LightVela Product Beta Launch`。
- 不替换现有 Changelog 图片，不修改其他月份内容或业务逻辑。

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
