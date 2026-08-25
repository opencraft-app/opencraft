# Advanced Settings Documentation Design

## Goal

Add an Advanced Settings documentation page immediately after Diagnostics in the Features & Configuration navigation for both LightVela documentation sites.

The domestic site receives a Chinese page.

The international site receives English, Simplified Chinese, Indonesian, and generated Traditional Chinese output.

## Scope

The page documents the six settings already implemented for domestic Hermes Agents: persistent memory, user profile, automatic compression, compression threshold, compression retention ratio, and protected recent messages.

It explains the per-setting save flow, Gateway restart and read-back verification, group-level restore defaults, expected result, and common error handling.

The page does not include images, screenshots, internal implementation details, or unverified product claims.

Although the global route is not currently live, the international documentation uses the same configuration behavior as requested.

## Information Architecture

The new slug is `configuration/advanced-settings`.

It appears immediately after `configuration/diagnostics` in the domestic and global sidebars.

The content belongs to the existing Features & Configuration A-tier documentation category.

## Files

- Domestic Chinese source: `src/content/docs/configuration/advanced-settings.md`.
- International Simplified Chinese source: `src/content/docs/global/configuration/advanced-settings.md`.
- International English source: `src/content/docs/en/configuration/advanced-settings.md`.
- International Indonesian source: `src/content/docs/id/configuration/advanced-settings.md`.
- Navigation and slug registration: `src/config/docs-sidebar.ts`.
- Documentation metadata registration: `scripts/sync-fumadocs-content.mjs`.

## Verification

Run `pnpm docs:sync` to generate the rendered outputs.

Confirm that the Chinese domestic source and the English, Simplified Chinese, Indonesian, and Traditional Chinese international outputs exist.

Check that all sidebar, slug, and metadata registrations resolve to the new page and that the new documents have no image references or broken internal links.
