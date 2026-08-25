# Advanced Settings Documentation Implementation Plan

> Execute on the existing isolated `codex/amend_gaoji_shezhi` branch.
> Do not commit or push without explicit user approval.

## Goal

Publish an image-free Advanced Settings page after Diagnostics in the domestic and international documentation navigation.

## Task 1: Author localized documentation sources

**Files:**

- Create `frontend/src/content/docs/configuration/advanced-settings.md`.
- Create `frontend/src/content/docs/global/configuration/advanced-settings.md`.
- Create `frontend/src/content/docs/en/configuration/advanced-settings.md`.
- Create `frontend/src/content/docs/id/configuration/advanced-settings.md`.

**Steps:**

1. Follow the existing Diagnostics documentation structure, using a summary, prerequisites, task steps, expected result, and common problems.
2. Document the six supported controls: persistent memory, user profile, automatic compression, compression threshold, compression retention ratio, and protected recent messages.
3. Explain the confirmed interaction rules: switches save immediately; numeric fields save after confirmation; each successful change restarts the Gateway and reads the configuration back; restoring defaults acts on the current settings group.
4. Do not add images, screenshots, internal configuration keys, or unsupported availability claims.

**Verification:**

- Search the four new source files for image syntax and confirm there are no matches.

## Task 2: Register navigation, metadata, and category status

**Files:**

- Modify `frontend/src/config/docs-sidebar.ts`.
- Modify `frontend/scripts/sync-fumadocs-content.mjs`.
- Modify `wiki/growth-state/lightvela-docs-content-categories.md`.

**Steps:**

1. Add `configuration/advanced-settings` immediately after `configuration/diagnostics` in the domestic and global sidebar definitions and slug-to-file maps.
2. Add the document to the domestic and global Fumadocs source definitions, with Chinese and English titles and descriptions.
3. Add Indonesian title and description metadata so the Indonesian international page has localized navigation text.
4. Record the page in the existing Features & Configuration category status list for both sites.

**Verification:**

- Search each registration surface for `configuration/advanced-settings` and confirm the ordering follows Diagnostics.

## Task 3: Generate and validate rendered docs

**Files:**

- Generated `frontend/.fumadocs-content/docs/*/configuration/advanced-settings.mdx` outputs.
- Generated `frontend/next-site/docs-route-manifest.ts`, if changed by the sync command.

**Steps:**

1. Run `pnpm docs:sync` from `frontend/`.
2. Confirm rendered outputs for `zh-cn`, `en-us`, `zh-sg`, `zh-hant`, and `id-id` exist at the new slug.
3. Run `git diff --check` and the frontend validation command appropriate for documentation registration changes.
4. Review the final diff to confirm no images or unrelated files were added.

**Verification:**

- `pnpm docs:sync` exits successfully.
- The output files exist for all five requested locales.
- The registration check and final diff check pass.
