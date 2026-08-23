# 8 月 22 日 Hermes Agent 版本升级公告 Implementation Plan

**Status:** 实现与验证完成，等待用户确认提交和推送。

**Goal:** 国内站和国际站首页展示 2026 年 8 月 22 日 22:00 至次日 06:00 的 Hermes Agent 版本升级公告，并在维护窗口结束时自动撤下。

**Architecture:** 复用现有首页维护公告项，刷新公告 ID、失效时间和双站时区文案；保持国际站公测计费公告及轮播、关闭记忆、路径白名单逻辑不变。

- [x] 先补国内站、国际站公告文案和到期撤下测试并确认 RED。
- [x] 最小更新公告源与多语言字典，让定向测试 GREEN。
- [x] 完成 i18n、类型检查和差异校验。

**Verification:**
- RED：新增的国内、国际公告文案与到期撤下断言共 3 条按预期失败。
- GREEN：公告相关 2 个测试文件共 4 个用例通过。
- `pnpm check`、`pnpm i18n:check`、四语言公告翻译完整性检查与 `git diff --check` 通过。

---

# 通道连接弹窗按钮圆角修复 Implementation Plan

**Status:** 实现、验证与用户验收完成，等待提交并创建 MR。

**Goal:** 通道连接方式弹窗的取消、确认按钮复用产品控制台弹窗的 `rounded-lg` 圆角 token，避免因引用 Skills 面板私有变量而退化为直角。

- [x] 补充样式回归测试并确认现有实现失败。
- [x] 最小修复通道弹窗按钮圆角，保持 Skills 面板按钮样式不变。
- [x] 完成定向测试、类型检查与差异检查。

---

# 点石零元下单并支付 Implementation Plan

**Status:** 实现与定向验证完成，用户已授权直接提交并推送新远程分支。

**Goal:** 询价为零元的活动套餐通过独立点石 `do_goods_and_pay` 链路完成下单与发货，不展示绑卡或自动续费。

- [x] 新增 Trade 点石 `do_goods_and_pay` 客户端、业务方法和内部路由。
- [x] 新增 CTL 点石专用 adapter、逻辑方法和用户 API。
- [x] 新增前端 repository 方法并锁定请求路径。
- [x] 以 `real_total_cost === 0` 分流确认交互，并复用 Pass 发货轮询。
- [x] 完成定向测试、类型检查与 i18n 检查；全量前端测试因 Node 2 GB 堆内存耗尽中断。
- [ ] 提交并推送新远程分支。

---

# 国际站自动任务上游 Context Implementation Plan

**Status:** MR !3162 CR 修复与验证完成，等待用户确认提交和推送。

**Goal:** 将已经在国内站上线的自动任务上游 Context 能力同步到国际站，并保持其他既有区域差异不变。

**Architecture:** 复用现有 Hermes `context_from` 探测、关系水合、单上游表单、关系展示和带回滚删除链路；仅移除这些能力上的 `isGlobal` 隔离，不改终止任务、场景任务、通知渠道或技能选择器的区域行为。

### Task 1: 用国际站测试锁定能力对齐

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.global.test.ts`

**Acceptance:**
- 国际站加载自动任务时探测 `context_from` 并水合任务关系。
- 卡片、详情和创建/编辑表单展示英文上游任务信息。
- 选择上游时走结构化创建/编辑；删除被引用任务时走依赖解绑与回滚链路。
- 国际站既有终止任务行为不变。

- [x] 先补国际站失败测试并确认 RED。

### Task 2: 移除上游 Context 的国际站隔离

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`

**Acceptance:**
- 国际站与国内站共用上游任务读写、展示、能力探测和安全删除逻辑。
- 只移除 `context_from` 相关区域判断；保留其他 `isGlobal` 产品差异。

- [x] 完成最小实现并让定向测试 GREEN。

### Task 3: 同步产品范围并完成质量门禁

**Files:**
- Modify: `wiki/prd-docs/2026-08-13-自动任务支持获取上游任务的Context.md`
- Modify: `frontend/openspec/plan.md`

**Acceptance:**
- PRD 将发布范围更新为国内站与国际站，并保留技能选择器的区域差异说明。
- 定向测试、TypeScript 检查、i18n 检查、国际站构建和 `git diff --check` 通过；浏览器冒烟在登录态允许时执行，否则记录阻塞。

- [x] 同步文档、完成验证并展示证据。

**Verification:**
- RED：国际站专属测试先出现 3 个预期失败，分别命中关系水合、详情/安全删除和结构化创建隔离。
- GREEN：相关 4 个测试文件共 226 个用例通过，包含国际站创建、编辑、展示、删除和既有终止任务回归。
- `pnpm check`、`pnpm i18n:check`、`pnpm build:global`、`git diff --check` 通过。
- 已登录浏览器确认当前线上国际站尚未展示 `Upstream task`；本地新版本因 `localhost` 无登录态无法完成同一页面的交互式截图，改由国际站组件集成测试留证。

### Task 4: 补齐印尼语上游任务文案

**Files:**
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Add: `frontend/src/pages/marketing/__tests__/automation-upstream-picker.id-ID.test.tsx`
- Modify: `frontend/openspec/plan.md`

**Acceptance:**
- `id-ID` 下上游任务能力状态、选择器标签与空状态均渲染为非空印尼语。
- 当前创建、展示、校验与安全删除链路涉及的上游/下游关系文案均有非空印尼语翻译。
- 不修改全局 `returnEmptyString`、fallback 或 `i18n:check` 规则，不扩大本 MR 范围。

- [x] 先补印尼语渲染与字典完整性测试并确认 RED。
- [x] 只补本功能实际使用的印尼语 key，让定向测试 GREEN。
- [x] 运行相关回归、类型检查、i18n 检查、国际站构建和 `git diff --check`。

**Verification:**
- 新增测试先确认 RED：31/31 失败；补齐翻译后 31/31 通过。
- 上游 Context 相关 5 个测试文件共 257 个测试通过。
- `pnpm check`、`pnpm i18n:check`、`pnpm build:global` 通过。
- 印尼语空翻译由 208 条降至 178 条，本次实际使用的 30 条文案全部补齐。

---

# 国际站通知空态隐藏后台运行说明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认提交并创建 CR。

**Goal:** 国际站没有任何已配置通知通道时，将空态文案精简为 `No channels configured.`，并隐藏不适用的后台运行说明及其占位高度。

**Architecture:** `AutomationFormModal` 继续使用现有国际站通道清单和配置判定，新增一个与空态共用的“存在可用通知通道”布尔值。该值只控制空态与说明行的互斥渲染，不改变通道加载、选择、提交或测试发送链路。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、react-i18next。

## Global Constraints

- 仅影响国际站自动任务弹窗的通知空态和英文翻译。
- 无通道时保留 `Configure channels`，不展示后台运行说明，也不保留 spacer/占位行。
- 有已配置通道但未选择时，继续展示后台运行说明。
- 国内站、通知通道范围、Hermes 命令、任务提交和后端接口保持不变。
- 不同步 MR !2961 的“展示全部未配置国际站通道”行为。

---

### Task 1: 条件隐藏国际站通知空态说明

**Role:** Developer / Reviewer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:2956-2963,3477-3506,3671-3682`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:1302-1328`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Reference: `frontend/openspec/changes/2026-08-21-hide-empty-notification-hint-design.md`

**Interfaces:**
- Consumes: `GLOBAL_NOTIFICATION_CHANNELS`、`isGlobal`、`enabledChannels`、`channelStatus`、`isHermesNotificationChannelConfigured(...)`。
- Produces: 组件内布尔值 `hasAvailableNotificationChannel: boolean`；不新增导出、公共类型或 API。

- [x] **Step 1 — 写失败回归测试**

  将现有国际站空态测试改为锁定新文案和说明隐藏，并增加“已有通道但未选择”正向用例：

  ```tsx
  it("hides the background-only hint in the global channel empty state", () => {
    if (!isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(),
      channelStatus: "ready",
    });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("No channels configured.")).toBeTruthy();
    expect(screen.queryByText("No notification channels are configured yet.")).toBeNull();
    expect(screen.queryByText(
      "If none are selected, the agent will only run the task in the background without sending notifications.",
    )).toBeNull();
    expect(screen.getByRole("link", { name: "Configure channels" })).toHaveAttribute("href", "/agents/channels/");
  });

  it("keeps the background-only hint when a global channel is available", () => {
    if (!isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["telegram"]),
      channelStatus: "ready",
    });

    expect(screen.getByRole("checkbox", { name: "Telegram" })).toBeEnabled();
    expect(screen.getByText(
      "If none are selected, the agent will only run the task in the background without sending notifications.",
    )).toBeTruthy();
  });
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "hides the background-only hint in the global channel empty state|keeps the background-only hint when a global channel is available" \
    --api.host 127.0.0.1
  ```

  Expected: 新空态测试失败，旧实现仍渲染长文案和后台运行说明；正向用例通过。

- [x] **Step 3 — 完成最小实现与英文翻译**

  在现有派生状态附近增加单一判断：

  ```tsx
  const hasAvailableNotificationChannel = !isGlobal || GLOBAL_NOTIFICATION_CHANNELS.some(
    ({ key, comingSoon }) => isHermesNotificationChannelConfigured(enabledChannels, key, comingSoon),
  );
  ```

  用 `!hasAvailableNotificationChannel` 进入现有国际站空态，并仅在该值为 `true` 时渲染 spacer 与后台运行说明/等高占位：

  ```tsx
  {hasAvailableNotificationChannel ? (
    <>
      <div aria-hidden="true" style={{ height: 4 }} />
      {deliverPlatforms.length === 0 ? (
        <p className="text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
          {t("如不选，智能体只会在后台执行任务，不发通知。")}
        </p>
      ) : (
        <p aria-hidden="true" className="text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
          {"\u00A0"}
        </p>
      )}
    </>
  ) : null}
  ```

  将 `k_2efe0742` 的英文翻译更新为：

  ```json
  "k_2efe0742": "No channels configured."
  ```

- [x] **Step 4 — 运行精准双区域回归**

  Run:

  ```bash
  cd frontend
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "hides the background-only hint in the global channel empty state|keeps the background-only hint when a global channel is available" \
    --api.host 127.0.0.1
  VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "keeps unconfigured domestic channels visible and disables their checkboxes" \
    --api.host 127.0.0.1
  ```

  Expected: 国际站 2 个用例、国内站 1 个用例全部通过。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  pnpm build:global
  cd ..
  git diff --check
  git status --short
  ```

  Expected: 类型检查、i18n 检查、国际站构建与 diff 检查通过；最终范围仅包含计划、组件、测试和英文翻译，不包含构建生成物。

  Evidence:

  - RED：国际站精准用例首次运行 `1 failed / 1 passed`，失败点为新短文案尚未渲染。
  - GREEN：国际站 `2 passed`；国内站保护用例 `1 passed`。
  - `pnpm check`：通过，包含繁中一致性、Fumadocs 同步与 TypeScript 检查。
  - `pnpm i18n:check`：通过，英文 `2323/2323`，无缺失；印尼语 `208` 条既有待翻译项。
  - `pnpm build:global`：通过，完成 TypeScript、369 个静态页面生成及 SEO 检查。
  - 浏览器冒烟：本地国际站 `/agents/` 可加载；未登录环境停在 `Please sign in first`，无法进入自动任务弹窗，因此不作为弹窗验收证据。
  - `git diff --check`：通过；构建生成文件已清理。

- [x] **Step 6 — 验收与提交门禁**

  汇总 RED/GREEN、双区域回归、构建和最终 diff；等待用户明确确认后才允许 `git commit`、`git push` 或创建 MR。

---

# 技能包 ACLI 原生批量安装 Implementation Plan

**Status:** MR !3125 CR 修复与验证完成，等待用户确认提交和推送。

**Goal:** 技能包安装优先通过单次 ACLI `batch-install` 执行，减少多次 `/debug/exec` 与进程启动；在旧 ACLI、不完整批量结果、CLI 升级提示或单项失败时保留可靠兜底。

**Architecture:** 复用 Skills 页已有的流式批量结果解析与去重逻辑，为技能包注入带国内 SkillHub 下载模板的批量命令；批量命令不可用时回落到现有逐个安装，批量中的失败项仅逐项重试。组件从现有 repository 向 Experts 面板透传流式执行能力。

**Scope:** 国内站技能包安装链路；不改变单技能安装、国际站 registry、套餐定义、安装状态存储或后端接口。

### Task 1: 以测试锁定批量优先和兜底契约

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-experts-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`

**Acceptance:**
- 技能包默认只发起一次带 `SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE` 的 `acli skills batch-install --wait=true`。
- 原生命令不支持时执行现有逐个安装；批量部分失败时只逐个重试失败 slug。
- CLI 升级提示仍只触发一次 `skillhub self-upgrade`，随后重试批量命令。

- [x] 先补失败测试并确认 RED，覆盖批量成功、旧 ACLI 回退、部分失败重试和升级后重试。

### Task 2: 接入原生批量执行并保留恢复策略

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-skills-panel.tsx`

**Acceptance:**
- 复用既有批量事件解析，避免 `progress` 与完整 `summary.results` 重复事件导致结果错配。
- 包级进度持续更新；仅全部技能最终成功时记录套餐为已安装。
- 无流式执行能力时兼容现有逐个安装路径。

- [x] 完成最小实现并让定向测试 GREEN。

### Task 3: 验证范围和质量门禁

**Files:**
- Modify: `frontend/openspec/plan.md`
- Add: `frontend/openspec/changes/2026-08-20-skill-package-native-batch-design.md`

**Acceptance:**
- 定向测试、TypeScript 检查、i18n 检查和 `git diff --check` 通过。
- 展示真实改动与验证证据，等待用户确认后才提交、推送或创建 MR。

- [x] 完成验证并输出验收摘要。

### Task 4: 修正 CR 中的进度与诊断问题

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-experts-panel.test.tsx`
- Modify: `frontend/src/pages/marketing/agent-experts-panel.tsx`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/openspec/changes/2026-08-20-skill-package-native-batch-design.md`

**Acceptance:**
- 批量阶段进入 `3/3` 后，补装早期失败项不会让用户可见进度回退。
- ACLI 批量结果少于请求项时，诊断日志明确记录未覆盖并进入逐项补装的 slug。
- 保留“所有失败结果均提示升级”才重跑 batch 的严格条件，并在设计文档中写清。

- [x] 先补失败测试并确认 RED，再完成最小修复和定向验证。

---

# Cruise placeholder paid gate fix

**Status:** Implemented and verified; approved for commit and push.

**Goal:** Keep the international Cruise placeholder disabled when paid billing is off, while preserving the real CTL-backed Cruise purchase path when paid billing is on.

### Task: Remove the global placeholder release override

**Role:** Developer

**Files:**
- Modify: `frontend/next-site/subscribe-page.tsx`
- Test: `frontend/next-site/__tests__/subscribe-page.global.test.tsx`

**Acceptance:**
- Paid billing off: the frontend Cruise placeholder remains `comingSoon` and cannot enter checkout.
- Paid billing on: backend Cruise bundles remain purchasable through the existing CTL payment flow.
- No backend, bundle mapping, or domestic-site behavior changes.

- [x] Add a failing international-site regression test for the disabled placeholder.
- [x] Remove the Cruise `releasedOnGlobal` override and make the test pass.
- [x] Run targeted tests, type checking, i18n checking, and diff checks.

**Verification:**
- `pnpm exec vitest run next-site/__tests__/subscribe-page.test.tsx next-site/__tests__/subscribe-page.global.test.tsx` (7 tests passed)
- `pnpm check`
- `pnpm i18n:check`
- `git diff --check`

---

# Agent 导航 CR 修正 Implementation Plan

**Status:** 实现与验证完成，等待用户确认提交和推送。

**Goal:** 修正隐藏高级工具与分组导航的布局结构、测试耦合及分组命名语义。

**Scope:** 仅调整 Agent 左侧导航组件、对应样式和定向测试；不改变四个可见一级分类、菜单顺序、路由或隐藏工具的开启方式。

### Task 1: 统一导航结构与可访问语义

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

**Acceptance:**
- 隐藏的终端、浏览器入口与普通分组使用同一 items 容器，桌面缩进和窄屏栅格一致。
- 可见分组通过 `aria-labelledby` 引用可见标题；导航项使用列表语义。
- 删除颜色、间距和高度的 CSS 精确字符串断言，改由渲染测试验证结构与归属。

- [x] 先补充渲染失败测试并确认 RED。
- [x] 实现最小组件和样式调整并确认 GREEN。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

---

# 已安装技能实例展开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 修复 `/agents/skills` 已安装列表在 SkillHub 返回同名聚合技能时漏展示 `instances[]` 子实例的问题。

**Architecture:** SkillHub installed parser 将 `skills[].instances[]` 展开为独立 `InstalledSkill` 行；实例 `rawId` 保持为命令目标，`slug` 优先使用 `relative_path` 供展示和搜索；已安装列表搜索纳入 `slug` 与 `nativeAliases`。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library。

## Global Constraints

- 仅调整 `/agents/skills` 已安装清单的数据解析、展示标识和搜索匹配。
- 不修改安装、卸载命令格式；SkillHub 实例卸载仍使用实例 `id/rawId` 作为命令目标。
- 不新增 API、依赖、区域分支、视觉结构或 i18n 资源。

---

### Task 1: 展开 SkillHub installed instances 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- Modify: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`
- Test: `frontend/src/pages/marketing/skills-demo/skill-registries.test.ts`
- Test: `frontend/src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

**Interfaces:**
- Consumes: `acli skills list` JSON 中的 `skills[].instances[]`、`id`、`name`、`display_name`、`relative_path`、`version`。
- Produces: 每个 instance 对应一条 `InstalledSkill`；`rawId` 用于命令，`slug/nativeAliases` 用于展示、搜索和合并匹配。

- [x] **Step 1 — 增加失败回归测试**
  - 解析器测试覆盖 `humanizer.instances[]`，断言 `unclecheng-reduce-ai-perception-v2` 被展开为独立行。
  - UI 测试覆盖已安装搜索可按 instance `relative_path` 命中，列表展示路径但卸载仍携带实例 `rawId`。

- [x] **Step 2 — 运行测试并确认 RED**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Expected: FAIL，旧实现只展示 top-level `humanizer` 且搜索不到 `unclecheng-reduce-ai-perception-v2`。

- [x] **Step 3 — 实现最小修复**
  - 展开 SkillHub `instances[]`，保留父级分类/展示名兜底。
  - 让已安装列表展示 `skill.slug`，搜索匹配 `slug/nativeAliases`。

- [x] **Step 4 — 运行定向测试与质量门禁**
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`
  - Run: `cd frontend && pnpm check && cd .. && git diff --check`

- [x] **Step 5 — 修复已安装搜索框双清除按钮**
  - 在已安装搜索框有值时保留自定义清除按钮，禁用 Chromium/WebKit 原生 search cancel 和 decoration。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`

- [x] **Step 6 — 统一三个 Tab 搜索框聚焦样式**
  - 技能、技能包、已安装搜索框统一使用 `lv-agent-search-box`、`lv-agent-search-box-icon`、`lv-agent-search-box-input`。
  - 已安装搜索框保留自定义清除按钮和原生 search cancel 禁用，外层固定宽度不受共享 `width: 100%` 影响。
  - Run: `cd frontend && pnpm exec vitest run src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx --testNamePattern "uses the skill package search field styling|suppresses the native search clear"`

- [ ] **Step 7 — 验收确认**
  - 汇总 diff、验证结果和剩余风险；等待用户确认后再提交、推送或 MR。

---

# 即将到期 Tooltip 视觉修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 增量实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 将 `/agents` 左侧“即将到期”标签的浏览器原生灰色提示框替换为符合 `DESIGN.md` 的自定义 hover/focus Tooltip。

**Architecture:** 在续费提醒按钮外增加无布局副作用的 `group relative inline-flex` 包装层，Tooltip 作为同级绝对定位元素显示在按钮上方。该位置没有裁剪祖先，因此采用 `DESIGN.md` 推荐的内联方案，不引入 Portal 定位状态；按钮点击续费逻辑保持不变。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 移除续费提醒按钮的原生 `title`，避免系统灰色提示框。
- Tooltip 使用白底深色字、细边框、6px 圆角（Tailwind 默认 `rounded-md` 的视觉值）、`px-3 py-1.5`、`text-[11px] font-medium` 与 `0 8px 24px rgba(15,23,42,0.12)` 轻阴影。
- Tooltip 位于触发器上方居中，带白底小三角，支持 hover、focus、鼠标进入与文本选择。
- 不修改“即将到期”标签本身、剩余时间计算、点击续费逻辑、文案或 i18n 资源。
- 国内站和国际站共用同一实现，不增加区域条件分支。

---

### Task 1: 用自定义 Tooltip 替换原生 title 并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4989-5008`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx:180-195`

**Interfaces:**
- Consumes: `passExpiryReminder.tooltip` 现有剩余时间文案与续费提醒按钮。
- Produces: `role="tooltip"` 的可选择自定义浮层；不新增导出或公共接口。

- [x] **Step 1 — 增加失败回归测试**

  更新现有续费提醒用例，断言按钮不再包含 `title`，页面存在对应 `role="tooltip"`，并锁定白底、细边框、6px 圆角、11px 字号、轻阴影、可交互和可选择样式。

- [x] **Step 2 — 运行测试并确认 RED**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: FAIL，旧实现仍有原生 `title` 且没有自定义 Tooltip。

- [x] **Step 3 — 实现最小 Tooltip 调整**

  用 `group relative inline-flex` 包裹提醒按钮，删除 `title`，增加位于上方居中的自定义 Tooltip 与小三角；通过透明 `pb-2` hover 桥接按钮和气泡。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: 该测试文件全部通过。

- [x] **Step 5 — 运行质量门禁并本地预览**

  Run: `cd frontend && pnpm check && pnpm i18n:check && cd .. && git diff --check`

  Expected: 全部以退出码 `0` 完成；在已登录本地预览中 hover/focus “即将到期”时显示新 Tooltip，点击仍打开续费弹窗。

- [x] **Step 6 — 验收门禁**

  展示改动与验证结果；仅在用户明确确认后提交、推送或创建 MR。

---

### Task 2: 在 Tooltip 内增加续费入口并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:5007-5024`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx:187-220`

**Interfaces:**
- Consumes: `passExpiryReminder.tooltip` 与现有 `setRenewPassModalOpen(true)`。
- Produces: Tooltip 内原生文字按钮“续费套餐”；不新增状态、组件、导出或公共接口。

- [x] **Step 1 — 增加失败回归测试**

  在现有 Tooltip 用例中查询 Tooltip 内的“续费套餐”按钮，断言其可聚焦，并点击后出现续费弹窗；原提醒标签打开续费弹窗的行为继续由实名认证用例覆盖。

- [x] **Step 2 — 运行测试并确认 RED**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: FAIL，Tooltip 内尚不存在“续费套餐”按钮。

- [x] **Step 3 — 实现最小文字按钮**

  在剩余时间文案后增加原生 `<button type="button">续费套餐</button>`，使用当前提醒橙色、hover 下划线和可见焦点样式；点击时阻止冒泡并复用 `setRenewPassModalOpen(true)`。

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run: `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-renewal-reminder.test.tsx`

  Expected: 该测试文件全部通过。

- [x] **Step 5 — 运行质量门禁并本地交互回验**

  Run: `cd frontend && pnpm check && pnpm i18n:check && cd .. && git diff --check`

  Expected: 全部以退出码 `0` 完成；本地 hover 后点击“续费套餐”能打开续费弹窗，Tooltip 在按钮 hover/focus 时保持可见。

- [x] **Step 6 — 验收门禁**

  展示本地效果与验证结果；仅在用户明确确认后提交、推送或创建 MR。

- [x] **Step 7 — 补充可点击鼠标样式并回验**

  为 Tooltip 内“续费套餐”文字按钮增加 `cursor-pointer`，扩展现有测试断言，并在本地预览确认计算样式为 `cursor: pointer`。

- [x] **Step 8 — 补充提醒标签可点击鼠标样式并回验**

  为外层“即将到期 / 临近到期”按钮增加 `cursor-pointer`，扩展现有测试断言，并在本地预览确认计算样式为 `cursor: pointer`；不改变 hover 颜色、焦点样式或点击逻辑。

- [x] **Step 9 — 更新 Tooltip 续费入口文案**

  将 Tooltip 内入口从“续费套餐”调整为“立即续费”，保留弹窗标题“续费套餐”和现有点击、焦点、cursor 行为；更新定向测试并回验。

---

# 自动任务最近执行空状态去灰底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，等待用户验收；不自动提交实现、推送或创建 MR。

**Goal:** 去掉 `/agents/automations/` 最近执行空状态行的浅灰色背景与圆角，同时保留外层白色卡片和其余视觉属性。

**Architecture:** 沿用 `RecentCronRunsPanel` 的现有结构，只删除空状态行上的两个 Tailwind class。扩展现有组件测试直接渲染空记录状态，锁定内层背景/圆角移除且外层卡片仍存在，不新增组件、导出或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Vitest 4、Testing Library。

## Global Constraints

- 仅调整空状态行，不修改有记录列表、加载态、错误态、页签、刷新交互或 Hermes Cron 逻辑。
- 删除 `bg-black/[0.02]` 和 `rounded-lg`，保留空状态行的间距、图标、字号和颜色。
- 保留外层白色卡片的边框、阴影和 `rounded-md`。
- 国内站和国际站共用同一组件，不增加区域条件分支。
- 不新增依赖、文案或 i18n 生成文件。

---

### Task 1: 移除最近执行空状态灰底并验证

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:1109-1115`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:45-105`
- Design: `frontend/openspec/changes/2026-08-13-frontsandbox-automation-empty-state-transparent-design.md`

**Interfaces:**
- Consumes: `RecentCronRunsPanel` 现有 `runs` 与 `skillLoadState` props。
- Produces: 不新增导出；国内站和国际站继续渲染同一空状态 JSX。

- [x] **Step 1 — 增加失败回归测试**

  在 `recent run limit hint` 测试组中增加空状态用例：

  ```tsx
  it("renders the empty recent-runs message without a nested gray container", () => {
    const { container } = render(createElement(RecentCronRunsPanel, {
      runs: [],
      skillLoadState: { status: "ready", slugs: [], error: null },
    }));
    const message = screen.getByText("暂无执行记录");
    const emptyState = message.closest("div");
    const panel = container.querySelector("section");

    expect(emptyState).not.toBeNull();
    expect(emptyState).toHaveClass("m-4", "px-3", "py-2", "text-xs", "text-black/45");
    expect(emptyState).not.toHaveClass("bg-black/[0.02]", "rounded-lg");
    expect(panel).toHaveClass("rounded-md", "bg-white");
    expect(panel).toHaveStyle({ background: "#ffffff" });
  });
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
  ```

  Expected: FAIL，空状态行仍包含 `bg-black/[0.02]` 和 `rounded-lg`。

- [x] **Step 3 — 实现最小样式调整**

  将空状态行改为：

  ```tsx
  <div className="m-4 flex items-center gap-2 px-3 py-2 text-xs text-black/45">
  ```

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts
  ```

  Expected: 该测试文件全部通过，现有最近执行详情测试保持不变。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: TypeScript、i18n 和 diff 检查均以退出码 `0` 完成；不产生生成资源变更。

- [x] **Step 6 — 验收门禁**

  展示 diff 与验证结果；只有用户明确确认后才执行实现提交、推送或创建 MR。

---

# 2026-08-12 首页 Hero 浅色化

**Status:** 前端实现与基础检查已完成，待用户视觉验收后再提交 / MR。

**Goal:** 参考 `lightvela-next.zip` 的浅色首屏方向，重做首页 Hero 视觉层，去掉视频背景，提升整体轻盈感和顶部导航可读性。

**Scope:** 仅调整首页 Hero 区视觉实现；保留现有首页业务链路、CTA 跳转、i18n 文案、Header 组件和后续内容区。

## Tasks

- [x] 移除首页 Hero 的视频背景和对应加载状态。
- [x] 用浅色静态背景与现有装饰素材重组 Hero 首屏。
- [x] 完成 TypeScript / i18n / diff 检查，并用本地预览截图验证桌面与移动端可读性。
- [x] 移除 Hero 外层最大/最小高度限制，确保常见浏览器缩放 25%～125% 下 Hero 仍占满首屏。

---

# 更新日志左侧日期样式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认 commit / push / MR。

**Goal:** 参考 Viktor Changelog，将 `/changelog` 左侧月份改成带日历勾选图标的紫色日期标签，同时保持页面其他部分不变。

**Architecture:** 继续使用 `ChangelogMonthGroup` 和现有双列网格，只在月份标签的 JSX 中复用 `lucide-react` 的 `CalendarCheck` 并替换局部样式。通过现有国内站 Changelog 渲染测试锁定图标、尺寸、间距和颜色，不新增组件、数据字段或依赖。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS v4、Lucide React、Vitest 4、Testing Library。

## Global Constraints

- 仅修改左侧月份标签及其回归测试，不修改日期数据、正文、配图、右侧时间线、页头、页脚或滚动行为。
- 使用 `#6E47FF` 前景色，不增加背景、边框、圆角或额外水平内边距。
- 标签固定 `48px` 高，图文间距 `16px`，图标 `20px`。
- 不新增依赖、组件、翻译文案或 i18n 生成文件。

---

### Task 1: 更新月份标签并验证

**Files:**
- Modify: `frontend/src/pages/marketing/changelog-page.tsx:8-12,404-421`
- Test: `frontend/src/pages/marketing/__tests__/channel-copy.test.tsx:69-99`
- Design: `frontend/openspec/changes/2026-08-12-frontsandbox-changelog-date-style-design.md`

**Interfaces:**
- Consumes: `ChangelogMonthGroup.month` 现有本地化月份字符串；`lucide-react` 的 `CalendarCheck`。
- Produces: 不新增导出；所有月份分组共用同一日期标签 JSX。

- [x] **Step 1 — 增加失败回归断言**

  在现有 `announces reliable Skill invocation for automations in the July changelog` 用例中，把月份存在性断言扩展为：

  ```tsx
  const monthText = screen.getByText("2026 年 7 月");
  const monthLabel = monthText.closest("p");

  expect(monthLabel).not.toBeNull();
  expect(monthLabel).toHaveClass(
    "inline-flex",
    "h-12",
    "items-center",
    "gap-4",
  );
  expect(monthLabel).not.toHaveClass("rounded-full", "px-6");
  expect(monthLabel).toHaveStyle({ color: "#6E47FF" });
  expect(monthLabel).not.toHaveStyle({
    backgroundColor: "rgba(110, 71, 255, 0.16)",
  });
  expect(monthLabel?.querySelector(".lucide-calendar-check")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  ```

- [x] **Step 2 — 运行测试并确认 RED**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx
  ```

  Expected: FAIL，现有月份 `<p>` 仍带有 `rounded-full px-6` 和淡紫色背景。

- [x] **Step 3 — 实现最小日期标签样式**

  在 `changelog-page.tsx` 导入图标：

  ```tsx
  import { CalendarCheck } from "lucide-react";
  ```

  将左列月份 JSX 替换为：

  ```tsx
  <div className="pt-1">
    <p
      className="inline-flex h-12 items-center gap-4"
      style={{
        color: "#6E47FF",
        fontSize: "16px",
        fontWeight: 400,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      <CalendarCheck className="size-5 shrink-0" aria-hidden="true" />
      <span>{group.month}</span>
    </p>
  </div>
  ```

- [x] **Step 4 — 运行定向测试并确认 GREEN**

  Run:

  ```bash
  cd frontend
  pnpm exec vitest run src/pages/marketing/__tests__/channel-copy.test.tsx src/pages/marketing/__tests__/global-changelog.test.tsx
  ```

  Expected: 两个测试文件全部通过，国内站和国际站现有 Changelog 内容断言保持不变。

- [x] **Step 5 — 运行质量门禁**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  cd ..
  git diff --check
  ```

  Expected: TypeScript、i18n 和 diff 检查均以退出码 `0` 完成；不产生 i18n 文件变更。

- [x] **Step 6 — 浏览器验证**

  启动本地前端并检查 `/changelog`：

  ```bash
  cd frontend
  pnpm dev:cn
  ```

  Expected:

  - 桌面端：月份标签位于左列，图标和文字垂直居中，不显示底框。
  - 移动端：月份标签按内容宽度左对齐，标签自身不增加横向溢出。
  - 右侧标题、描述、配图和点线时间轴与修改前一致。

  Verification evidence:

  - 用户标注的 `888 × 933` 视口：标签 `131.14 × 48px`，计算样式为透明背景、`0px` 边框、`0px` 圆角、`0px` 左右内边距。
  - 移动端：日期标签位于单列内容区内；页面既有页头说明文本使用 `white-space: nowrap`，会产生原有横向溢出，本次遵循范围约束未修改。
  - 浏览器控制台无 error。
  - 完整 `pnpm test` 仍有 1 条既有失败：`scripts/docs-image-assets.test.ts` 检出 9 个超出 `512 KiB` 的文档 PNG（被中英文文档重复引用为 18 条）；本分支未修改这些图片、文档或测试。

- [x] **Step 7 — 等待提交确认**

  展示 diff、测试结果和浏览器验证截图；只有用户明确确认后才执行 `git commit`、`git push` 或创建 MR。

---

# 2026-08-11 国际站首页默认英文一致性修复

**Status:** 实现中；确认前不 commit / push / MR。

**Goal:** `lightvela.ai/` 裸首页在浏览器残留中文语言偏好时仍默认全页英文，只有访问中文 locale 路径或用户显式切换中文时展示中文。

**Scope:** 仅收敛公开首页 locale 判定、公告条 locale 注入、首页导入区翻译调用和回归测试；不改视觉布局、路由 SEO 输出、后端接口或订阅/登录逻辑。

## Tasks

- [x] 修复国际站裸 `/` 的 i18n 初始语言，避免被 `localStorage.lw-locale=zh-CN` 覆盖。
- [x] 修复首页公告条与 FeatureSection 对全局 i18n 单例的依赖，统一跟随公开路由 locale。
- [x] 补充回归测试并运行定向测试、i18n 检查、类型检查和 diff 检查。

---

# 国际站 Skills 搜索结果来源链接 Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站所有 Skills 搜索结果都在技能标题和 slug 下方单独展示文字型 `Source` 链接；ClawHub 统一链接到 `https://clawhub.ai/`。

**Architecture:** `SearchSkillRow` 继续使用 skills.sh 的技能详情链接，但对 ClawHub 直接使用固定官网地址。
链接只由前端渲染，不查询 ClawHub 作者或技能详情，因此不会新增 ClawHub 请求或增加限流风险。

**Tech Stack:** React 19、TypeScript 5.9、Tailwind CSS、Vitest 4、React Testing Library。

## Global Constraints

- 仅影响国际站的 ClawHub 与 skills.sh 搜索结果。
- 国内 SkillHub 搜索结果不展示新来源行。
- 所有 ClawHub 搜索结果都显示来源链接，固定 URL 为 `https://clawhub.ai/`。
- 标签通过现有 i18n `t("来源")` 渲染，样式与 skills.sh 的文字型来源链接一致。
- 不新增依赖、动画或新的交互原语。

## Tasks

- [x] **Task 1: 固定 ClawHub 搜索结果来源链接。**
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，先断言 ClawHub 搜索结果的 `来源` 链接固定为 `https://clawhub.ai/`。
  - 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，仅在 global mode 的 `SearchSkillRow` 中为 ClawHub 使用固定官网链接，skills.sh 与国内站逻辑保持不变。
  - 运行 `pnpm exec vitest run src/pages/marketing/skills-demo/skill-registries.test.ts src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`。

- [x] **Task 2: 运行质量门禁并记录验证。**
  - 运行 `pnpm i18n:check`。
  - 运行 `pnpm check`。
  - 检查 `git diff --check` 与最终 diff，确认未修改国内站分支逻辑。

---
# Agents 左侧导航顺序调整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** 实现与验证完成，用户已确认提交、推送与创建 MR。

**Goal:** 将 `/agents` 左侧导航中的“自动任务”移动到“人设”上方，并保持其余导航行为不变。

**Architecture:** 沿用 `AgentSettingsPage` 内现有 `settingsSections` 数组作为唯一顺序来源，只交换两个相邻配置项。用独立静态回归测试锁定两项顺序，避免为了单一展示顺序抽离新公共接口。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4。

## Global Constraints

- 仅修改导航顺序及其回归测试，不修改路由、图标、文案、权限或页面内容。
- 桌面和移动端继续共用同一导航配置。
- 不新增依赖或配置抽象。

## Tasks

- [x] **Task 1 — Developer / Reviewer：交换导航项并验证**
  - **Files:**
    - Create: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
    - Modify: `frontend/src/pages/marketing/agent-settings-page.tsx:4909-4915`
  - **Interfaces:** 不新增导出；测试只读取页面源码中的 `settingsSections` 配置片段。
  - **Step 1 — 写失败测试：** 新测试读取 `agent-settings-page.tsx`，截取 `const settingsSections` 到 `const isRestartDisabled` 之间的文本，并断言 `id: "automations"` 的索引小于 `id: "buddy"`：

    ```ts
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { describe, expect, it } from "vitest";

    describe("Agent settings navigation order", () => {
      it("places automations before persona", () => {
        const page = readFileSync(
          join(process.cwd(), "src/pages/marketing/agent-settings-page.tsx"),
          "utf8",
        );
        const settingsSectionsStart = page.indexOf("const settingsSections");
        const settingsSectionsEnd = page.indexOf("const isRestartDisabled");

        expect(settingsSectionsStart).toBeGreaterThanOrEqual(0);
        expect(settingsSectionsEnd).toBeGreaterThan(settingsSectionsStart);

        const settingsSections = page.slice(settingsSectionsStart, settingsSectionsEnd);
        const automationsIndex = settingsSections.indexOf('id: "automations"');
        const personaIndex = settingsSections.indexOf('id: "buddy"');

        expect(automationsIndex).toBeGreaterThanOrEqual(0);
        expect(personaIndex).toBeGreaterThanOrEqual(0);
        expect(automationsIndex).toBeLessThan(personaIndex);
      });
    });
    ```
  - **Step 2 — 确认 RED：** 在 `frontend/` 运行 `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`；预期当前顺序下断言失败。
  - **Step 3 — 最小实现：** 在 `settingsSections` 中把完整的 `automations` 配置项移动到完整的 `buddy` 配置项之前，不改动两项内容：

    ```tsx
    { id: "automations", label: t("自动任务"), icon: <CalendarClock className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.automations },
    { id: "buddy" as const, label: t("人设"), icon: <UserRound className="h-4 w-4" />, path: AGENT_SECTION_PATH_BY_ID.buddy },
    ```
  - **Step 4 — 确认 GREEN：** 重新运行同一定向 Vitest，预期 1 个测试通过。
  - **Step 5 — 完整验证：** 在 `frontend/` 运行 `pnpm check`，再在仓库根运行 `git diff --check`；检查 diff 仅包含计划、测试和两项顺序调整。
  - **Step 6 — 验收门禁：** 展示改动与验证结果，等待用户确认后才允许提交实现、推送或创建 MR。

---

# 2026-08-07 批量安装汇总结果对齐修复

**Status:** 实现与验证完成；等待用户确认后再 commit / push / MR。

**Goal:** ACLI 同时返回逐项 `progress` 和完整 `summary.results` 时，避免重复汇总结果错配到下一个未完成技能，确保部分失败状态准确展示。

**Scope:** 仅修正 Skills 批量安装结果匹配逻辑并补回归测试；不改变 ACLI 命令、SSE 协议、取消粒度或页面交互。

## Tasks

- [x] 增加“progress 后返回完整 summary.results”的失败回归测试并确认 RED。
- [x] 修正已完成结果的去重与无标识结果的顺序降级逻辑。
- [x] 运行 Skills 定向测试、类型检查、i18n 检查和 diff 检查。

---

# 2026-08-09 EdgeOne Pages 裸根路径 404 修复

**Status:** 实现与 Preview 验证完成，用户已确认提交、推送并创建 MR。

**Goal:** 让 EdgeOne Pages 的裸根路径 `/` 直接由 Build Output 的 filesystem 路由提供静态首页，避免显式重写 `/index.html` 触发 Pages 路由缓存分裂和概率性平台 404。

**Scope:** 仅调整 EdgeOne Build Output 路由生成及其回归测试；不修改页面运行时代码、外层加速域名配置或生产发布配置。

## Tasks

- [x] 先补充失败测试，禁止生成 `^/$ -> /index.html` 显式根路由。
- [x] 删除显式根路由，保留 filesystem 与普通目录 HTML fallback 的顺序。
- [x] 运行定向测试、frontend 检查并验证生成配置。
- [x] 发布 Preview，连续验证不带查询参数的裸 `/`。
- [x] 用户确认后提交、推送并创建 MR。

## Verification

- `pnpm exec vitest run scripts/fix-next-static-html-lang.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-08-07 国际站 Skills 来源说明对齐国内站

**Status:** 实现与验证完成，等待用户手动验收；不自动 commit / push / MR。

**Goal:** 将国际站搜索来源说明从搜索栏移到搜索结果底部，复用国内站“查看更多居中、来源说明靠右”的蓝色布局，并恢复搜索框宽度及来源筛选器右对齐。

**Scope:** 仅调整国际站 Skills 搜索区域布局和对应组件测试；保留 Skills.sh、ClawHub 链接、搜索过滤与展开逻辑，不改变国内站行为。

## Tasks

- [x] **Developer / Test:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.test.tsx`，断言国际站搜索栏不再包含来源说明、结果底栏展示蓝色 Skills.sh 与 ClawHub 链接，并确认测试按预期失败。
- [x] **Developer / UI:** 修改 `src/pages/marketing/skills-demo/SkillsDemoPanel.tsx`，复用国内站三列结果底栏，删除搜索栏旧说明；验收时搜索框占满剩余宽度、来源筛选器靠右。
- [x] **Reviewer / Verification:** 运行 Skills 定向测试、`pnpm i18n:check`、`pnpm check` 和 `git diff --check`，确认国内站布局断言保持通过且无新增依赖或生成资源。

---

# 2026-08-07 国际站合并技能卸载降级

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 删除同时标记为 ClawHub 与 skills.sh 的单个运行时技能时，不重复执行两个卸载命令导致 `SKILLS_SH_NOT_INSTALLED`。

**Scope:** 合并行的来源标识作为候选卸载命令；任一候选成功后停止，明确未安装时尝试下一候选，其他错误继续正常失败。

## Tasks

- [x] 增加“首个来源成功即停止”和“首个来源未安装则降级”的失败回归测试。
- [x] 调整国际站卸载候选执行与错误处理逻辑。
- [x] 运行 Skills 定向测试、i18n、类型检查和 diff 检查。

---

# 2026-08-07 国际站已安装技能跨来源去重

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 国际站同一 Hermes 运行时技能同时出现在 ClawHub 与 skills.sh 已安装清单时，仅展示一行，并同时展示两个来源标签。

**Scope:** 仅调整国际站已安装技能归并逻辑与回归测试；保留各 registry 的真实卸载目标，不按短 slug 盲目合并无 Hermes 证据的记录。

## Tasks

- [x] 增加跨来源重复安装记录的回归测试，并确认当前实现失败。
- [x] 以 Hermes 运行时记录为归并证据，合并 ClawHub 与 skills.sh 展示记录并保留双来源卸载目标。
- [x] 运行定向测试、类型检查和 diff 检查。

---

# 2026-08-06 前端预览图片体积优化

**Status:** 实现与验证完成，等待用户验收；不自动 commit / push / MR。

**Goal:** 将分支预览压缩包从约 60 MiB 降到 45-50 MiB，避免接近 StaticPages 上传链路的疑似 64 MiB 边界。

**Scope:** 仅优化文档中超过 512 KiB 的 PNG/JPEG 源图及其 Markdown 引用，并增加资源体积回归测试；不调整页面布局、搜索、视频或生产发布逻辑。

## Tasks

- [x] 增加文档大图格式与体积回归测试，并确认现有资源会触发失败。
- [x] 将超预算文档图片转换为 WebP，更新中英文 Markdown 引用和公开资源副本。
- [x] 运行定向测试、类型检查和 global 预览构建，核验压缩包体积为 43.50 MiB。

---

# 2026-08-04 QQ Bot 群聊策略自动开启

**Status:** 实现与验证完成，待用户验收；确认前不 commit / push / MR。

**Goal:** 在 LightVela 通道配置 SDK 的 QQ 卡片中，用户通过扫码或 AppID / Secret 绑定 QQ Bot 时，自动在同一次 debug/exec 命令里先执行 `hermes config set platforms.qqbot.extra.group_policy open`，再执行 SDK 原始 QQ 绑定命令，避免额外触发第二次 gateway restart。

**Scope:** 仅修改前端 SDK debug/exec 适配链路、QQ group policy helper、相关单测和 QQ 通道文档；不修改 SDK 包版本、不修改后端接口、不提交远端代码。

## Tasks

- [x] 新增 QQ group policy 命令识别与包装 helper，覆盖 AppID / Secret 与扫码两条 QQ 绑定命令。
- [x] 扩展 debug/exec lifecycle 支持 `transformCommand`，并提供 lifecycle 组合 helper，保证模型切换自动任务同步不被覆盖。
- [x] 在 `/agents` 设置页接入 QQ lifecycle，使 SDK QQ 配置卡片下发命令前完成 group_policy 注入。
- [x] 更新 QQ 通道中英文文档，说明绑定后默认开启群聊 @ 对话及 `open` 权限边界。
- [x] 运行相关 Vitest、类型检查和 diff 检查，停在用户验收确认点。

## Verification

- `pnpm exec vitest run src/pages/marketing/__tests__/agent-qqbot-group-policy.test.ts src/pages/marketing/__tests__/agent-debug-exec-lifecycle.test.ts src/pages/marketing/__tests__/agent-tat-adapter.test.ts src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts`
- `pnpm check`
- `git diff --check`

---

# 2026-07-31 Hermes 版本升级公告

**Status:** 前端实现完成，待用户验收后再提交 / MR；关联 Vitest 受当前 jsdom 依赖链阻塞。

**Goal:** 基于最新 `master` 在首页公告条挂今晚 Hermes 版本升级提醒，国内站与国际站均展示对应时区文案。

**Scope:** 仅更新首页公告条、对应中英文 i18n 字典和本计划；不调整公告视觉结构、路由、登录态、后端接口或其他公告轮播逻辑。

## Tasks

- [x] 将 Hermes 升级公告切换到 2026-07-31 22:00 至 2026-08-01 02:00。
  - 国内站文案使用北京时间。
  - 国际站文案使用新加坡时间。
  - 公告 ID 更新，避免复用上一次关闭记忆。
  - 过期时间为 UTC 2026-07-31 18:00。
- [x] 更新 i18n 生成字典并补齐英文翻译。
- [x] 完成基础验证：`pnpm i18n:check`、`pnpm check`、global 环境 `pnpm check`、`git diff --check`、公告静态 smoke。
- [ ] 关联 Vitest 复跑：当前 `vitest related src/components/site/maintenance-announcement-banner.tsx` 被 `jsdom@28.1.0 -> html-encoding-sniffer@6.0.0 -> @exodus/bytes` 的 `ERR_REQUIRE_ESM` 阻塞，未进入业务断言。

---

# 国内站登录弹窗交互优化 Implementation Plan

**Status:** 前端实现已完成，待用户验收后再提交 / MR / 归档。

**Goal:** 国内站登录弹窗默认微信登录，手机号与 QQ 作为底部其他登录方式；手机号登录成为正式入口；不引入后端改动。

## Constraints

- 仅国内站生效，国际站登录方式保持不变。
- 不新增后端接口。
- 不修改 `user/auth`。
- 不修改 `service-gateway`。
- 微信和 QQ 均复用现有 OAuth start URL 跳转；不调用不存在的 `modal-config` 接口。
- 手机号登录复用现有 `PhoneLoginForm`。

## Current Implementation

### 国内站弹窗

- `LoginModal` 维护 `DomesticLoginMethod = "wechat" | "phone" | "qq"`。
- 弹窗打开时默认重置为微信登录。
- 当前选中的登录方式展示在主体区域；另外两种登录方式展示在底部“其他登录方式”。
- 国际站仍走原有 Google / GitHub 登录逻辑，不进入国内站三方式状态机。

### 微信 / QQ

- 微信主体展示“微信账号登录”按钮，QQ 主体展示“QQ账号登录”按钮。
- 两者均复用 `repositories.auth.getOAuthStartUrl(...)` 和 `redirectToOAuthStart(...)`。
- 微信按 user agent 选择现有 OAuth target：
  - 桌面浏览器：`website`
  - 微信内浏览器：`official_account`
  - 普通移动浏览器：提示“请在微信中打开当前页面后继续登录。”
- 不嵌入二维码、不加载微信 JS、不新增后端配置接口；如果后端不支持扫码弹窗，按 QQ 的按钮跳转方式回退。

### 手机登录

- 手机主体复用 `PhoneLoginForm` 的 `variant="modal"`。
- 手机登录标题保留为“手机登录”，副标题“使用手机号和短信验证码登录”已删除。
- 表单可访问 label 保留，但视觉上使用 `sr-only` 隐藏，不再显示“手机号 / 短信验证码”字段标题。
- 输入框文字使用普通字重；输入框、验证码按钮使用 `rounded-md` 和轻边框，聚焦态保持浅色 1px ring。
- 未输入手机号或验证码时，登录按钮禁用。
- 手机号 / 验证码校验错误分别显示在对应输入框下方，并同步将对应输入框边框置为红色。
- 手机登录的协议勾选放在登录按钮上方；微信 / QQ 的协议勾选位于主体按钮下方、“其他登录方式”上方。

### 其他登录方式

- 底部按钮为 logo + 文案，无按钮框线。
- 微信、QQ、手机 icon 使用固定 icon slot，统一视觉大小；两个其他登录方式之间使用竖线分隔。
- 国内站内容容器底部保留 `pb-6`，避免底部登录选项贴近弹窗下边框。

## Tasks

- [x] 更新登录弹窗国内站状态机：`wechat | phone | qq`。
- [x] 默认方式设置为微信，弹窗打开时重置到微信。
- [x] 微信主体改为 OAuth 跳转按钮，保留微信 logo。
- [x] 手机主体展示手机号验证码登录表单。
- [x] QQ 主体展示 OAuth 跳转按钮，保留 QQ logo。
- [x] 协议勾选移动到“其他登录方式”上方。
- [x] 底部其他方式按钮改为无边框、logo + 文案、竖线分隔。
- [x] 回退微信扫码 / 快捷登录嵌入方案，不新增 `modal-config` 后端接口。
- [x] 统一底部微信 / QQ / 手机 icon 视觉尺寸。
- [x] 手机登录删除副标题和视觉字段标题，改为轻量表单结构。
- [x] 手机登录协议勾选移动到登录按钮上方。
- [x] 手机登录输入框样式按 `DESIGN.md` 调整为轻边框、`rounded-md`、普通字重、浅聚焦态。
- [x] 手机登录错误提示改为字段下方红字，并同步红色边框。
- [x] 手机登录未填手机号或验证码时禁用登录按钮。
- [x] 增加弹窗底部空间，避免其他登录方式贴近下边框。
- [x] 更新国内站登录弹窗单测。
- [x] 更新手机号登录表单单测。
- [x] 更新 i18n 文案。
- [x] 修复 review 发现的动态创建失败文案 i18n 字典回退问题。
- [x] 补充微信移动端 fallback 与手机登录协议 gate 的 LoginModal 回归测试。
- [x] 更新认证模块长期规格，区分 `/auth/sign-in` 手机主路径和共享登录弹窗微信默认状态机。
- [ ] 用户验收后再进入提交 / MR / 归档流程。

## Verification

- `pnpm --dir frontend exec vitest run src/components/site/__tests__/login-modal.test.tsx src/components/site/__tests__/login-modal.global.test.tsx src/components/auth/__tests__/phone-login-form.test.tsx src/pages/marketing/__tests__/agent-create-error.test.ts`
- `pnpm --dir frontend i18n:check`
- `pnpm --dir frontend check`
# 2026-08-06 Frontend release Docker monorepo context fix

**Status:** 实现与验证完成，等待用户确认提交。

**Goal:** 修复 frontend 正式镜像构建无法解析仓库内 `file:../velalink` 依赖的问题，同时保持 Docker build context 最小化。

**Scope:** 仅调整 frontend release bundle、Dockerfile、Dockerfile 专属 ignore 和构建契约测试；不修改 frontend 或 velalink 运行时代码。

## Tasks

- [x] 将 frontend release bundle 的 build context 切换为仓库根，并把 `velalink` 纳入变更触发范围。
- [x] 更新 Dockerfile 的根目录相对 COPY 路径，显式复制 `/velalink`。
- [x] 用 Dockerfile 专属 ignore 仅放行 `frontend/` 与 `velalink/`。
- [x] 运行契约测试、diff 检查和真实 Tokyo `linux/amd64` 构建推送验证。

## Verification

- `python3 .ci/runtime/tests/contract_tests/test_build_release_image.py`
- `python3 .ci/runtime/tests/contract_tests/test_release_bundle_contracts.py ReleaseBundleContractTests.test_frontend_playground_release_uses_beijing_registry`
- 国内构建机真实执行 `build_release_image.py --service frontend --env sandbox-jp-1 --platform linux/amd64 --push --reuse-existing`
- JP TCR manifest：`frontend-6cf545e930d2`，`linux/amd64`
- `git diff --check`

---

# 模型配置页 CR 问题修复 Implementation Plan

**Status:** Task 9 MiniMax 模型发现与检测修复完成，等待用户验收；不自动提交或推送。

**Goal:** 修复 MR !3181 评审指出的静态模型不可添加、备用模型凭据丢失、连通性检测假阳性、Tooltip 被裁剪、印尼语文案为空和模型列表探测被表述为真实连接的问题。

**Architecture:** 保持现有页面、Hermes debug/exec 通道和 Provider 产品配置边界不变。Hermes helper 在实例内原位修改 fallback 原始条目；前端只消费不含凭据的快照。模型列表优先采用实时探测，实时结果为空时仅以产品静态目录补充可选项；Tooltip 复用现有 Portal/fixed 浮层模式。

**Scope:** 仅修改 `agent-model-config` 模块、该页面四语言资源、对应定向测试和本计划；不改 SDK、Provider 产品配置、后端接口、Hermes 命令行为或页面整体结构。

### Task 1: 保留备用模型原始凭据字段

- [x] 在 `model-config-client.test.ts` 先增加失败测试，覆盖追加、取消和 legacy 迁移时已有 fallback 的 `api_key`、`key_env`、`api_key_env` 与未知扩展字段保持不变。
- [x] 修改 `hermes-model-config-command.ts`，让 fallback 增删直接基于实例内原始配置条目，只把脱敏后的模型视图返回前端。
- [x] 运行客户端定向测试确认 GREEN，且命令、输出与前端响应不包含明文 Key。

### Task 2: 连通性检测校验选中模型

- [x] 在 `model-config-client.test.ts` 先增加失败测试，覆盖 Provider 返回其他模型但不含当前 `model_id` 时检测失败。
- [x] 修改 Hermes helper，仅在探测结果包含选中模型 ID 时返回成功；空结果和不匹配结果返回就近错误。
- [x] 运行客户端定向测试确认 GREEN，并保留现有加密凭据传输断言。

### Task 3: 静态模型目录作为获取结果兜底

- [x] 先增加失败测试，覆盖 MiniMax 类 Provider 实时探测为空或 Hermes 返回 `models: None` 时，使用 `catalogModels` 填充下拉并允许添加。
- [x] 将面板模型选项统一为带 `id`、`name`、`source` 的结构；实时结果优先，只有实时结果为空且非自定义 Provider 时使用静态目录。
- [x] 覆盖无实时结果且无静态目录时仍不可添加、自定义 Provider 不使用静态兜底，并运行面板定向测试确认 GREEN。

### Task 4: 操作 Tooltip 脱离裁剪容器

- [x] 在 `model-config-panel.test.tsx` 先增加失败测试，断言 Tooltip 渲染到 `document.body`，支持 hover/focus、鼠标进入气泡和文本选择。
- [x] 将 `ModelActionTooltip` 改为 `createPortal` + `fixed` 定位，复用项目现有浮层定位模式；监听 resize 和 capture scroll 更新位置，保留短暂关闭缓冲。
- [x] 运行面板定向测试确认 GREEN，并检查按钮可访问名称、焦点状态和禁用原因提示不回退到原生 `title`。

### Task 5: 独立 CR 补充边界

- [x] 将模型 route 身份对齐 Hermes `(provider, model, normalized_base_url)`，同 Provider/模型的不同 endpoint 可独立删除且保留各自凭据。
- [x] 复用 Hermes fallback 链并按三元组去重，legacy 重复 route 不再写入 `fallback_providers`。
- [x] 将连通性请求绑定 Provider 指纹与 revision，Provider 变化后忽略延迟响应。
- [x] 解除两个 Dialog 的手工 description ID 覆盖，交由 Radix 自动关联并消除可访问性警告。

### Task 6: 修复 FE-AI 复审问题

- [x] 保留 Hermes `models: None` 的探测失败语义，仅在探测成功但模型列表为空时使用静态目录。
- [x] 拆分原始 route 身份与 Hermes runtime deployment 判定，精确增删 fallback 并拒绝无效主备组合。
- [x] 删除模型前检查 Provider、模型与 key env 的剩余引用，避免破坏兄弟 endpoint。
- [x] 将新增凭据失败回滚收窄为本次 `.env` 写入，不清理操作前已有的凭据池或镜像状态。
- [x] 补齐失败测试、真实 Hermes smoke、类型、i18n 与 diff 门禁后重新执行 FE-AI review。

### Task 7: 修复最新评审的本地化与探测语义问题

- [x] 先补模型配置页印尼语完整性测试，以及模型可用性检测成功文案测试并确认 RED。
- [x] 补齐本页面新增的 35 条印尼语翻译，并将连接成功/失败文案收紧为模型列表可用性语义。
- [x] 运行模型配置定向测试、类型检查、i18n 检查和 diff 门禁后重新执行 FE-AI review。

### Task 8: 修复类型门禁与模型身份契约

- [x] 建立真实执行 `tsconfig.app.json` 的无新增错误门禁，并接入前端 CI，避免 solution-style `tsconfig.json` 导致类型检查空跑。
- [x] 统一模型身份输入类型、先收窄 `probeSucceeded` 再写入快照，并清零模型配置模块源代码与测试代码的类型错误。
- [x] 删除 `regionId === 5` 的失效地域推导，改为只透传明确的 region/Zone，并完成定向测试、类型基线、i18n 与 diff 验证。

### Task 9: 修复 MiniMax 静态发现与模型检测

- [x] 为 Provider 适配结果增加显式 `live | catalog` 模型发现策略，MiniMax 使用产品静态目录，其他预设和自定义 Provider 保持实时发现。
- [x] 将模型发现与模型可用性检测解耦；MiniMax 仅在用户主动点击“模型检测”时发送最小模型请求，验证当前 Key、endpoint 与所选模型。
- [x] 补齐 `models: None`、无效凭据、模型请求成功、其他 Provider 探测失败不回退目录等回归测试，并完成模型配置、类型、i18n 与 diff 门禁。

## Verification

- `pnpm exec vitest run src/pages/marketing/agent-model-config/__tests__/model-config-client.test.ts src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx src/pages/marketing/agent-model-config/__tests__/use-model-config.test.tsx`
- `pnpm check`
- `pnpm i18n:check`
- `git diff --check`

**Task 6 verification:** 7 个回归断言先按预期失败；模型配置相关 52 个测试通过、1 个环境测试跳过，真实 Hermes 源码 smoke 1/1 通过；`pnpm check`、`pnpm i18n:check`、`git diff --check` 通过。本地新进程 `http://127.0.0.1:5175/agents/models/` 返回 200。全仓测试另有 4 个未改动模块失败，随后一个 worker 持续满 CPU 无输出而终止，未作为本轮通过依据。

**Task 7 verification:** 新增本地化资源与检测语义断言先出现 38 个预期失败；实现后模型配置模块 90 个测试通过、1 个真实 Hermes 环境测试跳过。`pnpm check`、`pnpm i18n:check`、`git diff --check` 通过；英文待翻译为 0，印尼语待翻译由 213 条降至 178 条。本轮仅调整模型列表可用性文案与四语言资源，不改 Hermes 探测行为。

**Task 8 verification:** 地域适配 2 个回归断言先按预期失败；实现后 `pnpm test:model-config` 运行 7 个文件、94 个测试全部通过。真实类型门禁对空的根 `tsconfig.json` 和临时注入的 2 条诊断均按预期失败，最终 `pnpm check` 报告 276 条历史基线、0 条新增诊断。国内构建与 `frontsandbox/*` 预览流水线均接入 `set -euo pipefail` 质量步骤；独立 CR 指出的 3 个 P1 与 2 个可立即处理的 P2 已修复。实例 API 尚不提供 Zone，当前只移除失效推导并保留显式透传契约。

**Task 9 verification:** Provider 策略、MiniMax 静态目录、Anthropic/OpenAI 最小模型请求、凭据拒绝和安全 HTTP transport 共 6 个关键断言先按预期失败；实现后 `pnpm test:model-config` 运行 7 个文件、98 个测试全部通过，真实 Hermes 源码 smoke 1/1 通过。`pnpm check` 报告 276 条历史基线、0 条新增诊断；`pnpm i18n:check`、`git diff --check` 通过；本地 `/agents/models/` 编译并返回 200。

---
# My creations show() reveal Implementation Plan

**Status:** 实现与验证完成，等待用户验收；不自动提交、推送或创建 MR。

**Goal:** 国际站“我的作品”和账号页支付方式入口默认隐藏，仅在当前页面调用 `show()` 后展示，同时保持直接 URL 与订阅支付可用。

**Scope:** 仅调整头像菜单、Agent 导航、账号页支付方式区块及定向测试；不修改 `/agents/websites/` 路由、订阅下单、API 或后端。

### Task 1: 使用现有 show() 彩蛋控制“我的作品”入口

**Role:** Developer

**Files:**
- Modify: `frontend/src/components/site/user-avatar-menu.tsx`
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Test: `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`

**Acceptance:**
- 头像菜单和 Agent “使用”分组默认不显示“我的作品”。
- 调用 `window.show()` 后，两处入口按其所在组件生命周期展示。
- 直接访问 `/agents/websites/` 仍可渲染作品面板。
- 不修改网站 API、路由和后端能力。

- [x] 先补充失败测试并确认 RED。
- [x] 复用现有 `show()` 链式回调实现最小展示开关并确认 GREEN。
- [x] 运行定向测试、类型检查、i18n 检查和 diff 检查。

**Verification:**
- `pnpm exec vitest run src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`（12 tests passed）
- `pnpm i18n:check`
- `pnpm check`
- `git diff --check`

### Task 2: 使用 show() 控制账号页支付方式区块

**Role:** Developer

**Files:**
- Modify: `frontend/src/pages/marketing/account-page.tsx`
- Test: `frontend/src/pages/marketing/__tests__/account-page-payment-visibility.test.ts`

**Acceptance:**
- 国际站账号页默认不挂载“支付方式”区块。
- 在账号页调用 `window.show()` 后挂载“支付方式”区块。
- `show()` 继续调用页面上原有的同名 helper。
- 订阅页下单与信用卡支付流程不变。

- [x] 先补充失败测试并确认 RED。
- [x] 实现账号页局部展示状态并确认 GREEN。
- [x] 运行支付方式相关测试、类型检查、i18n 检查和 diff 检查。

**Verification:**
- `pnpm exec vitest run src/pages/marketing/__tests__/account-page-payment-visibility.test.ts src/pages/marketing/__tests__/saved-cards-section.test.tsx src/components/site/__tests__/user-avatar-menu.test.tsx src/pages/marketing/__tests__/agent-settings-nav-order.test.ts src/pages/marketing/__tests__/agent-console-helpers.test.ts`（34 tests passed）
- `pnpm i18n:check`
- `pnpm check`
- `git diff --check`

---
# 国内站自动任务仅展示已配置通知通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 国内站自动任务弹窗只展示已配置的微信、QQ、企业微信、飞书和钉钉通道，并在无配置时展示新的国内空态入口。

**Architecture:** 在自动任务模块内维护独立的国内候选通道常量，与国际站候选常量按区域选择后，共用配置状态过滤、空态和辅助说明判断。钉钉继续复用现有通用保存与测试发送链路，只补候选入口和中文展示名称。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、react-i18next。

## Global Constraints

- 国内候选范围及顺序固定为微信、QQ、企业微信、飞书、钉钉；不加入 Telegram、WhatsApp、Discord、Slack 或元宝。
- 国内站只展示 Hermes 已配置通道，未配置项不渲染。
- 国内站无配置时展示 `暂无已配置的通知通道。` 与 `前往通道配置`，链接仍为 `/agents/channels/`。
- 无配置时隐藏后台运行说明及占位高度；有通道但未选择时继续展示说明。
- 国际站通道范围、英文 `Configure channels`、空态和发送行为保持不变。
- 不修改 Hermes 状态解析、连接流程、发送命令、任务保存协议或后端接口。

---

### Task 1: 对齐国内站通知通道过滤并接入钉钉

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx:2009-2019,2495-2504,2946-2952,3464-3495`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts:1302-1345,1649-1659`
- Modify (generated): `frontend/src/i18n/generated/zh-to-key.json`
- Modify (generated): `frontend/src/i18n/generated/zh-CN.json`
- Modify (generated): `frontend/src/i18n/generated/zh-Hant.json`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Reference: `frontend/openspec/changes/2026-08-21-domestic-automation-configured-channels-design.md`

**Interfaces:**
- Consumes: `isGlobal`、`enabledChannels`、`channelStatus`、`isHermesNotificationChannelConfigured(...)`、`t(...)`。
- Produces: module-local `DOMESTIC_NOTIFICATION_CHANNELS` and component-local `availableNotificationChannels`; no new exports, APIs, command formats, or persisted fields.

- [x] **Step 1: 写国内空态、已配置钉钉和详情名称的失败测试**

  将区域感知测试更新为新契约：

  ```tsx
  it("shows the domestic empty state when no notification channel is configured", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(),
      channelStatus: "ready",
    });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("暂无已配置的通知通道。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "前往通道配置" })).toHaveAttribute("href", "/agents/channels/");
    expect(screen.queryByText("如不选，智能体只会在后台执行任务，不发通知。")).toBeNull();
  });

  it("shows only configured domestic channels including DingTalk", () => {
    if (isGlobal) return;
    renderAutomationForm({
      enabledChannels: new Set(["dingtalk", "feishu"]),
      channelStatus: "ready",
    });

    expect(screen.getByRole("checkbox", { name: "钉钉" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "飞书" })).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: "微信" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "QQ" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "企业微信" })).toBeNull();
    expect(screen.getByText("如不选，智能体只会在后台执行任务，不发通知。")).toBeTruthy();
  });
  ```

  同步更新文件后部的同名国内站保护测试，使其断言空态并加 `if (isGlobal) return;`，避免它继续守护旧的“未配置项置灰”契约。

  增加钉钉任务详情回归：

  ```tsx
  it("localizes DingTalk in task details", async () => {
    const job = makeCronJob({ id: "dingtalk-job", name: "钉钉通知任务", deliver: "dingtalk" });
    cronClientMocks.listCronJobs.mockResolvedValue([job]);
    render(createElement(HermesAgentAutomationsPanel, { botId: "bot-1" }));

    fireEvent.click(within(await getCronJobCard("钉钉通知任务")).getByRole("button", { name: "查看" }));
    const dialog = screen.getByRole("dialog");
    const notificationRow = within(dialog).getByText("通知方式").closest("div");
    expect(notificationRow).not.toBeNull();
    expect(within(notificationRow!).getByText("钉钉")).toBeTruthy();
    expect(within(notificationRow!).queryByText("dingtalk")).toBeNull();
  });
  ```

- [x] **Step 2: 运行精准用例并确认 RED**

  Run:

  ```bash
  cd frontend
  VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "shows the domestic empty state|shows only configured domestic channels including DingTalk|localizes DingTalk in task details" \
    --api.host 127.0.0.1
  ```

  Expected: 三个用例均失败；旧代码仍渲染四个未配置复选框、没有钉钉候选，并在详情中显示原始 `dingtalk` key。

- [x] **Step 3: 增加国内候选常量并统一过滤**

  在 `GLOBAL_NOTIFICATION_CHANNELS` 附近增加：

  ```tsx
  const DOMESTIC_NOTIFICATION_CHANNELS = [
    { key: "weixin", labelKey: "微信", comingSoon: false },
    { key: "qqbot", label: "QQ", comingSoon: false },
    { key: "wecom", labelKey: "企业微信", comingSoon: false },
    { key: "feishu", labelKey: "飞书", comingSoon: false },
    { key: "dingtalk", labelKey: "钉钉", comingSoon: false },
  ] as const;
  ```

  在 `AutomationFormModal` 中用当前区域候选派生可见列表：

  ```tsx
  const availableNotificationChannels = (isGlobal
    ? GLOBAL_NOTIFICATION_CHANNELS
    : DOMESTIC_NOTIFICATION_CHANNELS
  ).map((channel) => ({
    key: channel.key,
    label: "label" in channel ? channel.label : t(channel.labelKey),
    comingSoon: channel.comingSoon,
  })).filter(({ key, comingSoon }) => (
    isHermesNotificationChannelConfigured(enabledChannels, key, comingSoon)
  ));
  const hasAvailableNotificationChannel = availableNotificationChannels.length > 0;
  ```

  通知区域直接渲染 `availableNotificationChannels.map(...)`，删除国内站硬编码未过滤数组。保留现有 loading、选择、Chat ID、测试发送和微信限频分支。

  在详情名称映射中增加：

  ```tsx
  if (platform === "dingtalk") return t("钉钉");
  ```

- [x] **Step 4: 更新空态入口文案与 i18n 字典**

  将组件中的：

  ```tsx
  {t("去通道配置")}
  ```

  改为：

  ```tsx
  {t("前往通道配置")}
  ```

  Run:

  ```bash
  cd frontend
  pnpm i18n:extract
  pnpm i18n:zh-hant
  ```

  新 key 固定为 `k_3a42a311`。补齐：

  ```json
  // en-US.json
  "k_3a42a311": "Configure channels"

  // id-ID.json
  "k_3a42a311": "Konfigurasi kanal"
  ```

  `zh-to-key.json`、`zh-CN.json` 和 `zh-Hant.json` 只使用脚本生成结果，不手工改写。

- [x] **Step 5: 运行双区域 GREEN 回归**

  Run:

  ```bash
  cd frontend
  VITE_REGION=cn pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    --api.host 127.0.0.1
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.global.test.ts \
    --api.host 127.0.0.1
  VITE_REGION=global pnpm exec vitest run --config vitest.config.ts \
    src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    -t "hides the background-only hint in the global channel empty state|keeps the background-only hint when a global channel is available" \
    --api.host 127.0.0.1
  ```

  Expected: 国内站主文件、国际站专项文件和国际站空态 2 个精准用例全部通过。

- [x] **Step 6: 运行质量门禁并清理生成物**

  Run:

  ```bash
  cd frontend
  pnpm check
  pnpm i18n:check
  pnpm build
  pnpm build:global
  cd ..
  git diff --check
  git status --short
  ```

  Expected: 类型、i18n、国内/国际构建和 diff 检查通过；最终范围只包含设计/计划、自动任务组件、对应测试和必要 i18n 字典，不包含 `next-env.d.ts`、字体或构建输出。

- [x] **Step 7: 提交门禁**

  展示最终 diff、测试和构建证据，等待用户明确确认后再执行：

  ```bash
  git add frontend/openspec/plan.md \
    frontend/src/pages/marketing/agent-automations-panel.tsx \
    frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts \
    frontend/src/i18n/generated/zh-to-key.json \
    frontend/src/i18n/generated/zh-CN.json \
    frontend/src/i18n/generated/zh-Hant.json \
    frontend/src/i18n/generated/en-US.json \
    frontend/src/i18n/generated/id-ID.json
  git commit -m "对齐国内站自动任务通知通道展示 / feat: filter domestic automation channels"
  ```

### Task 2: 调整国内站通知通道展示顺序

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Modify: `frontend/openspec/changes/2026-08-21-domestic-automation-configured-channels-design.md`

**Acceptance:**
- 国内站已配置通道按微信、QQ、企业微信、飞书、钉钉展示。
- 过滤未配置通道后，剩余通道仍保持上述相对顺序。
- 国际站顺序保持不变。

- [x] 先增加国内五通道顺序断言并确认 RED。
- [x] 调整国内候选常量和邻近说明并确认 GREEN。
- [x] 运行国内完整面板测试、国际专项测试、类型检查和 diff 检查。

### Task 3: 补齐钉钉通道别名归一化与兜底优先级

**Files:**
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`
- Modify: `frontend/src/lib/hermes-cron-client.ts`
- Modify: `frontend/src/pages/marketing/scenario-task-cron.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Test: `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- Test: `frontend/src/pages/marketing/scenario-tasks/__tests__/scenario-task-cron.test.ts`

**Acceptance:**
- 自动任务与场景任务都将 `openclaw-dingtalk` 归一化为 `dingtalk`。
- 场景任务将归一化后的 `dingtalk` 展示为“钉钉”，不暴露内部 key。
- canonical `dingtalk` 行为保持不变；不增加未经真实上报验证的 `ding` / `dingding` 别名。
- deliver fallback 在钉钉和国际通道同时在线时优先选择钉钉；钉钉位于飞书之后、Telegram 之前。
- 不改变其他通道别名、区域候选列表或发送协议。

- [x] 分别增加自动任务、场景任务与 fallback 的失败用例并确认 RED。
- [x] 最小修改三处归一化逻辑与 fallback priority 并确认 GREEN。
- [x] 运行相关测试、类型检查、i18n 检查和双区域构建。
- [x] 展示修复 diff 与验证结果，等待提交确认后更新 !3180。

---
