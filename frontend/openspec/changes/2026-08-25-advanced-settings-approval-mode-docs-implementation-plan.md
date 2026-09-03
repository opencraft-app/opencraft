# Advanced Settings Approval Mode Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the domestic and international Advanced Settings documentation to accurately cover Approval Mode and the Security group.

**Architecture:** Keep the existing A-tier configuration page and its images, routes, and sidebar entries unchanged.

Add concise, localized Security and Approval Mode guidance to the four existing source documents, update the corresponding Fumadocs metadata descriptions, and regenerate the checked-in rendered outputs.

**Tech Stack:** Markdown, Node.js documentation sync scripts, Fumadocs, existing LightVela i18n content sources.

## Global Constraints

- Do not change Advanced Settings product behavior, routes, sidebar entries, or image paths.
- Keep the user-provided `setting-1-cn.png` and `setting-1-en.png` replacements intact.
- Do not modify the unrelated `frontend/next-env.d.ts` worktree change.
- Do not expose Hermes configuration keys, terminal commands, internal service names, or unverified security guarantees.
- Keep the domestic Chinese, international Simplified Chinese, English, and Indonesian pages aligned in scope.
- Do not commit, push, or create an MR without separate user confirmation.

---

### Task 1: Update the four Advanced Settings source documents and metadata

**Files:**

- Modify: `frontend/src/content/docs/configuration/advanced-settings.md`.
- Modify: `frontend/src/content/docs/global/configuration/advanced-settings.md`.
- Modify: `frontend/src/content/docs/en/configuration/advanced-settings.md`.
- Modify: `frontend/src/content/docs/id/configuration/advanced-settings.md`.
- Modify: `frontend/scripts/sync-fumadocs-content.mjs`.

**Interfaces:**

- Consumes: The existing Security, Memory, and Context Management groups exposed by `AgentCommonSettingsPanel`.
- Produces: Four localized `configuration/advanced-settings.md` pages and metadata descriptions that cover the same three groups.

- [x] **Step 1: Add Security and Approval Mode to each page summary, coverage list, and settings table.**

Add the Security group before Memory.

State that Approval Mode offers Smart, Always Ask, and Off.

Describe Smart as the Agent's smart approval policy, Always Ask as a prompt for high-risk operations, and Off as no longer requesting approval for high-risk operations.

- [x] **Step 2: Add concise Approval Mode instructions and the Off confirmation boundary.**

Add a section before the existing switch-setting instructions.

State that users select a mode from the Approval Mode selector.

State that selecting Off opens a confirmation dialog and should be used only in a trusted environment.

State that the page shows an ongoing warning while Approval Mode is Off.

- [x] **Step 3: Correct save and restore-default behavior.**

Replace the statement that every successful save restarts the Gateway.

State that Approval Mode saves and is read back without a Gateway restart.

State that Memory and Context Management settings restart the Gateway before read-back verification.

Extend Restore defaults to Security, Memory, and Context Management.

State that restoring Security returns Approval Mode to Smart without changing Memory or Context Management settings.

- [x] **Step 4: Update Fumadocs metadata descriptions.**

Change the domestic Chinese description to `查看并调整 Hermes Agent 的安全、记忆和上下文管理配置。`.

Change the international English description to `Review and adjust Hermes Agent safety, memory, and context-management settings.`.

Change the Indonesian description to state that users can review and adjust Hermes Agent safety, memory, and context-management settings.

### Task 2: Regenerate and verify documentation outputs

**Files:**

- Modify: `frontend/src/content/docs/last-updated.json` if the timestamp tool updates it.
- Modify: `frontend/.fumadocs-content/docs/zh-cn/configuration/advanced-settings.mdx`.
- Modify: `frontend/.fumadocs-content/docs/zh-sg/configuration/advanced-settings.mdx`.
- Modify: `frontend/.fumadocs-content/docs/en-us/configuration/advanced-settings.mdx`.
- Modify: `frontend/.fumadocs-content/docs/id-id/configuration/advanced-settings.mdx`.
- Modify: `frontend/.fumadocs-content/docs/zh-hant/configuration/advanced-settings.mdx`.

**Interfaces:**

- Consumes: The localized Markdown sources and `sync-fumadocs-content.mjs` registrations from Task 1.
- Produces: Current rendered documentation pages for every supported Advanced Settings locale.

- [x] **Step 1: Refresh the documentation last-updated manifest.**

Run the repository's documentation timestamp script in update mode.

Expected: `src/content/docs/last-updated.json` records the current date for every changed Advanced Settings source file.

- [x] **Step 2: Generate rendered documentation.**

Run `cd frontend && pnpm docs:sync`.

Expected: The command exits successfully and refreshes the `zh-cn`, `zh-sg`, `en-us`, `id-id`, and `zh-hant` Advanced Settings MDX files.

- [x] **Step 3: Validate the localized output and static assets.**

Confirm that every generated page contains the localized Security and Approval Mode text.

Confirm that `setting-1-cn.png` remains referenced by Chinese outputs and `setting-1-en.png` remains referenced by English and Indonesian outputs.

Run `git diff --check` and inspect the changed documentation files for disallowed internal details and region-inappropriate terms.

## Self-Review

The plan covers the Security group, the three Approval Mode choices, the Off confirmation and warning, Security restore defaults, and the distinct save behavior.

The plan covers all four current source locales and all five generated output locales.

The plan changes no routes, sidebar entries, product behavior, or image references.

The plan contains no placeholders or undefined implementation details.
