# Agents Page Loading Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent 具体页面的首屏主数据加载统一为居中页面状态，避免页面标题、筛选器和内容卡片分段出现。

**Architecture:** 复用现有 `AgentPageLoadingState` 作为页面级首屏状态。每个页面根据自己的主数据快照定义 `initialLoading`；首次加载时渲染页面级状态，已有快照刷新时保留内容并显示局部 Spinner。浏览器、终端、Workbench 和成就页不在本次范围内。

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Tailwind CSS, Next.js.

## Global Constraints

- 页面级状态使用 `AgentPageLoadingState`，不重复实现 Spinner 容器。
- 首屏未完成时不渲染该页面的标题、筛选器、卡片或操作按钮。
- 已有数据刷新时保留当前快照，继续使用局部 `Spinner` 或 `aria-busy`。
- 错误和空状态继续使用现有 `AgentState` 语义。
- 不修改浏览器、终端、Workbench、成就页逻辑。
- 每个页面先补失败测试，再写实现；完成后运行页面专项测试和 `frontend/pnpm check`。

---

### Task 1: 统一通道页与高级设置页

**Files:**
- Modify: `frontend/src/pages/marketing/agent-channel-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-channel-panel.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`

**Interfaces:**
- Consumes: `ops.configData` / `ops.loading` from channel operations; `loading`, `snapshot`, `loadError`, `botStatus` from common settings.
- Produces: channel and common settings first-load branches that render `AgentPageLoadingState` before page headers and controls.

- [ ] **Step 1: Write failing tests**

  Add tests that hold the channel operation promise and the common-settings loader promise unresolved, then assert `role="status"` is present while the page heading is absent. Resolve the promise and assert the existing page content appears.

- [ ] **Step 2: Run tests to verify failure**

  Run `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-channel-panel.test.tsx src/pages/marketing/__tests__/agent-common-settings-panel.test.tsx`.
  Expected: the new assertions fail because the current page headers render before the data snapshot exists.

- [ ] **Step 3: Implement the page gates**

  Import `AgentPageLoadingState`. In the channel page, return it when the operation has no config snapshot and is still loading. In common settings, return it when `loading && !snapshot` and the bot is running. Keep stopped, error, and snapshot refresh branches unchanged.

- [ ] **Step 4: Run tests to verify the green state**

  Run the same Vitest command and expect all tests to pass.

### Task 2: Unify memory, skills, and experts pages

**Files:**
- Modify: `frontend/src/pages/marketing/agent-memory-views.tsx`
- Modify: `frontend/src/pages/marketing/agent-skills-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-experts-panel.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts`
- Test: `frontend/src/pages/marketing/__tests__/agent-skills-panel.test.tsx`
- Test: `frontend/src/pages/marketing/__tests__/agent-experts-panel.test.tsx`

**Interfaces:**
- Consumes: memory `loading/hasSnapshot`, skills demo initialization state, and experts `expertsLoading/visibleCards`.
- Produces: page-level first-load status while preserving card-level loading for subsequent refreshes and detail dialogs.

- [ ] **Step 1: Write failing tests**

  Add assertions for the three page boundaries: memory renders only the page status before a snapshot, skills hides its heading before the skills demo is ready, and experts hides the package list heading while its initial package request is pending.

- [ ] **Step 2: Run tests to verify failure**

  Run `cd frontend && pnpm exec vitest run src/pages/marketing/__tests__/agent-memory-page-boundary.test.ts src/pages/marketing/__tests__/agent-skills-panel.test.tsx src/pages/marketing/__tests__/agent-experts-panel.test.tsx`.
  Expected: the new assertions fail against the current partial-loading branches.

- [ ] **Step 3: Implement the page gates**

  Reuse `AgentPageLoadingState` in each page. Keep memory error/empty states available when loading completes. For skills, gate only the initial SkillsDemoPanel bootstrap and keep install/learn operations local. For experts, gate the package list before the first package snapshot and keep package-detail loading local.

- [ ] **Step 4: Run tests to verify the green state**

  Run the same Vitest command and expect all tests to pass.

### Task 3: Unify diagnostics, files, DeepSeek Harness, website, and session list

**Files:**
- Modify: `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-config/agent-file-manager-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-deepseek-harness-panel.tsx`
- Modify: `frontend/src/pages/marketing/agent-website-panel.tsx`
- Modify: `frontend/src/pages/marketing/agents-console/console-session-list.tsx`
- Test: matching existing page/console test files under `frontend/src/pages/marketing/__tests__/` and `frontend/src/pages/marketing/agents-console/__tests__/`

**Interfaces:**
- Consumes: each component's first request state and existing empty/error output.
- Produces: one centered loading status for each initial page request; session-list loading remains a navigation-only status because it is not the active page content.

- [ ] **Step 1: Write failing tests**

  Add one initial-loading assertion per page component. For `ConsoleSessionList`, assert the navigation status remains available without replacing the active page content.

- [ ] **Step 2: Run tests to verify failure**

  Run the affected Vitest files and confirm the new page-boundary assertions fail before implementation.

- [ ] **Step 3: Implement the page gates**

  Add `AgentPageLoadingState` only to the initial page request branches. Preserve diagnostics output, file-manager empty states, DeepSeek model errors, website static content, and console session list behavior after their first snapshot.

- [ ] **Step 4: Run tests to verify the green state**

  Run the affected Vitest files and expect all tests to pass.

### Task 4: Update design records and run repository verification

**Files:**
- Modify: `frontend/openspec/changes/2026-09-17-agents-loading-design.md`
- Modify: `frontend/openspec/changes/2026-09-17-agents-loading-implementation-plan.md`
- Modify: `frontend/openspec/plan.md`

- [ ] **Step 1: Record the expanded page boundary**

  Mark the unified page-loading rule complete for all in-scope pages and explicitly list the excluded browser, terminal, Workbench, and achievements pages.

- [ ] **Step 2: Run focused verification**

  Run the complete affected Vitest set, `git diff --check`, the documentation validator, and change-impact validator.

- [ ] **Step 3: Run the frontend quality gate**

  Run `cd frontend && pnpm check` and require `TypeScript diagnostics` to report `0 new` errors.

- [ ] **Step 4: Inspect the final worktree**

  Run `git status --short` and confirm only the intended source, test, and documentation files changed; leave the existing untracked sidebar fixture untouched.
