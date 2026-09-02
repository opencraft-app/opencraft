# Workbench Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the Workbench documentation page to both LightVela documentation sites, with the international English page and all locale versions kept in sync.

**Architecture:** Create Workbench source content for the domestic site and all international documentation locales.
Register the page in both sidebars, slug maps, SEO metadata, and Fumadocs metadata, then sync generated content.

**Tech Stack:** Markdown, Fumadocs, OpenCC, PNG documentation assets.

## Global Constraints

- Modify the domestic and international documentation sources.
- Keep the page after DeepSeek Harness in both feature configuration groups.
- Reference the five supplied images in their supplied order.
- Keep English and Simplified Chinese structure, facts, tables, warnings, and image positions aligned.
- Do not modify domestic documentation registration.

### Task 1: Register the international Workbench page

**Files:**

- Modify: `frontend/src/config/docs-sidebar.ts`
- Modify: `frontend/scripts/sync-fumadocs-content.mjs`
- Modify: `frontend/src/config/docs-sidebar.ts` international slug map

- [x] Add `configuration/workbench` immediately after `configuration/deepseek-harness` in `GLOBAL_SIDEBAR`.
- [x] Add `configuration/workbench: "configuration/workbench.md"` to `GLOBAL_SLUG_TO_FILE`.
- [x] Add English title `Workbench`, Chinese title `工作台`, and matching descriptions to `globalDocs`.

### Task 2: Add the bilingual content and supplied images

**Files:**

- Create: `frontend/src/content/docs/en/configuration/workbench.md`
- Create: `frontend/src/content/docs/global/configuration/workbench.md`
- Create: `frontend/src/content/docs/images/workbench-01.png` through `workbench-05.png`

- [x] Write the English page with the supplied Summary, workflow, status table, limits, common problems, boundaries, and FAQ.
- [x] Write the Simplified Chinese counterpart with the same heading order and image positions.
- [x] Reference `workbench-01.png` through `workbench-05.png` in supplied order.

### Task 3: Localize the Workbench page

**Files:**

- Create/update: `frontend/src/content/docs/es/configuration/workbench.md`
- Create: `frontend/src/content/docs/id/configuration/workbench.md`
- Create/update: `frontend/src/content/docs/ja/configuration/workbench.md`
- Create/update: `frontend/src/content/docs/ko/configuration/workbench.md`

- [x] Translate the Workbench content while preserving structure, links, tables, and image order.
- [x] Register Spanish and Indonesian metadata required by the document sync pipeline.

### Task 4: Add the domestic Workbench page and Chinese screenshots

**Files:**

- Create: `frontend/src/content/docs/configuration/workbench.md`
- Create: `frontend/src/content/docs/images/workbench-02-zh.png` through `workbench-04-zh.png`
- Modify: domestic sidebar, slug map, and `cnDocs` registration

- [x] Add the domestic Chinese page.
- [x] Use the supplied screenshots for images 2, 3, and 4 in domestic and international Chinese pages.
- [x] Keep the original images for English and other international languages.

### Task 3: Sync and validate the international docs

**Files:**

- Verify: `frontend/.fumadocs-content/docs/en-us/configuration/workbench.mdx`
- Verify: `frontend/.fumadocs-content/docs/zh-sg/configuration/workbench.mdx`

- [x] Run `cd frontend && pnpm docs:sync`.
- [x] Run `cd frontend && pnpm exec vitest run scripts/international-docs-parity.test.ts`.
- [x] Run `cd frontend && pnpm check` and `git diff --check`.
