# Agent Navigation Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `/agents` sidebar list with four always-expanded, task-oriented navigation groups.

**Architecture:** Keep section routes and panel rendering unchanged. Define grouped navigation data next to the existing section configuration, render each group as an accessible labeled container, and adapt the existing responsive CSS so each group owns its desktop list and mobile grid.

**Tech Stack:** React 19, TypeScript, Tailwind-compatible project CSS, Vitest, project i18n generation scripts.

## Global Constraints

- Group order: `配置 / Setup`, `使用 / Use`, `成长 / Growth`, `管理 / Manage`.
- Group contents: `通道、模型、技能`; `对话、自动任务、我的作品（国际站）`; `人设、记忆、成就`; `云存储、诊断中心`.
- First-level labels are static and always expanded; do not add accordion state or animation.
- Keep existing section routes, icons, active state, hidden tools, and feedback link behavior.
- Use a `2px` gap between second-level items and a `36px` item height; keep the `12px` first-level group gap unchanged.
- Do not commit, push, or create an MR without explicit user confirmation.

---

### Task 1: Group the Agent settings navigation

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/i18n/generated/zh-to-key.json`
- Modify: `frontend/src/i18n/generated/zh-CN.json`
- Modify: `frontend/src/i18n/generated/en-US.json`
- Modify: `frontend/src/i18n/generated/id-ID.json`
- Modify: `frontend/src/i18n/generated/zh-Hant.json`

**Interfaces:**
- Consumes: `AgentSettingsSectionId`, `AGENT_SECTION_PATH_BY_ID`, `getAgentSectionHref`, `isGlobal`, `SHOW_AGENTCHAT_ENTRY`.
- Produces: a local `settingsGroups` array whose items have `id`, translated `label`, and ordered `sections`.

- [ ] **Step 1: Write the failing navigation structure test**

Extend the source-boundary test to locate `const settingsGroups`, assert the four translated group labels appear in order, and assert each group contains its approved section IDs. Keep explicit non-negative boundary assertions so a removed section cannot pass through `-1` comparisons.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
NODE_OPTIONS='--require=/tmp/codex-lightvela-agents-nav-localhost-hook.cjs' pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts
```

Expected: the new grouping test fails because `settingsGroups` does not exist.

- [ ] **Step 3: Implement the grouped data and accessible rendering**

Replace the flat array with four groups. Render each group as:

```tsx
<div className="lv-agents-nav-group" role="group" aria-label={group.label}>
  <span className="lv-agents-nav-group-label">{group.label}</span>
  <div className="lv-agents-nav-group-items">
    {group.sections.map((section) => /* existing AppLink rendering */)}
  </div>
</div>
```

Keep the existing `AppLink`, icon, badge, `aria-current`, and active class behavior unchanged.

- [ ] **Step 4: Add responsive group styling**

Add focused classes for group spacing, label typography, child indentation, and group-owned mobile grids. Reuse existing colors, radii, sizes, and breakpoints; do not add animation or new visual effects.

- [ ] **Step 5: Generate and fill translations**

Run `pnpm i18n:extract`, set the new English values to `Setup`, `Use`, `Growth`, and `Manage`, and set Indonesian values to `Pengaturan`, `Penggunaan`, `Pertumbuhan`, and `Kelola`. Then run `pnpm i18n:zh-hant` to generate the Traditional Chinese values.

- [ ] **Step 6: Verify GREEN and project gates**

Run:

```bash
NODE_OPTIONS='--require=/tmp/codex-lightvela-agents-nav-localhost-hook.cjs' pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts src/pages/marketing/__tests__/agent-settings-sdk-boundary.test.ts
pnpm i18n:check
pnpm i18n:zh-hant:check
pnpm check
git diff --check
```

Expected: all commands exit `0`; focused Vitest reports all tests passing.

- [ ] **Step 7: Review the final diff without committing**

Confirm every changed production line traces to navigation grouping or its translations. Present the file scope and verification evidence, then wait for explicit authorization before any commit or push.

### Task 2: Tighten second-level item spacing

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-settings-nav-order.test.ts`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `.lv-agents-nav-group-items` and the existing source-boundary style test.
- Produces: a `2px` group-item gap and `36px` item height while preserving the `12px` group gap.

- [ ] **Step 1: Add the failing spacing assertion**

Read the `.lv-agents-nav-group-items` and `.lv-agents-nav-item` rules from `styles.css`; assert they contain `gap: 2px;` and `height: 36px;`.

- [ ] **Step 2: Run the focused test and verify RED**

Run `pnpm exec vitest run src/pages/marketing/__tests__/agent-settings-nav-order.test.ts` and expect the new assertion to fail because the rules still contain the earlier density values.

- [ ] **Step 3: Apply the minimal CSS change**

Change only this declaration:

```css
.lv-agents-nav-group-items {
  gap: 2px;
}

.lv-agents-nav-item {
  height: 36px;
}
```

- [ ] **Step 4: Verify GREEN and the live preview**

Run the focused navigation tests, `pnpm check`, and `git diff --check`. Confirm the already-running `/agents/` preview hot-reloads without an error overlay.

### Task 3: Separate initial loading from manual refresh feedback

**Files:**
- Modify: `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- Modify: `frontend/src/pages/marketing/agent-automations-panel.tsx`

**Interfaces:**
- Consumes: `refreshAll`, `loadingJobs`, `loadingRecentRuns`, and the existing refresh button.
- Produces: a local `manualRefreshing` state and `handleManualRefresh` callback.

- [ ] **Step 1: Add loading-state regression tests**

Render the panel with a deferred initial job request and assert the refresh button is disabled without `animate-spin`. After the initial request resolves, trigger an explicit refresh with another deferred request and assert the disabled icon spins until completion.

- [ ] **Step 2: Run the panel test and verify RED**

Run `pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts`. Expect only the new initial-loading assertion to fail because the icon currently derives its animation from `loadingJobs || loadingRecentRuns`.

- [ ] **Step 3: Add a manual refresh state**

Wrap `refreshAll()` in `handleManualRefresh()`, set `manualRefreshing` around the awaited call, keep the button disabled for either loading state, and derive `animate-spin` only from `manualRefreshing`.

- [ ] **Step 4: Verify GREEN and project gates**

Run the automation panel tests, navigation tests, `pnpm check`, and `git diff --check`. Confirm the local `/agents/automations/` route hot-reloads successfully.
