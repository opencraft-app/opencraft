# International Docs GEO Parity Design

## Goal

Replicate only the documentation information architecture and content introduced by
`jasminzhao-geo-article-720` from the domestic LightVela docs into the international
LightVela docs, while keeping `zh-sg` and `en-us` as independent localized sources.

## Source boundary

The source scope is the diff from the merge-base
`dad64aff49a27962540aab2c6793050e39175ae2` to
`jasminzhao-geo-article-720@71d1c08bc4b186e6ef9984d9b60d082065922020`.

Only branch-new domestic docs are eligible. Pre-existing differences between the
domestic and international docs are out of scope.

The branch added 37 domestic markdown pages. `configuration/automation.md` already
has independent `global/` and `en/` versions, so the international gap is 36 pages:

- Five complete pages:
  - `who-is-lightvela-for.md`
  - `plans.md`
  - `credits.md`
  - `create-first-hermes.md`
  - `configuration/memory.md`
- Thirty-one placeholder pages across configuration, use cases, comparisons,
  troubleshooting, security, advanced usage, and support.

## Content architecture

For each of the 36 missing pages:

- Create `frontend/src/content/docs/global/<file>.md` for international Chinese
  (`zh-sg`).
- Create `frontend/src/content/docs/en/<file>.md` for international English
  (`en-us`).
- Keep the same slug and heading hierarchy in both languages.
- Preserve placeholder status for the 31 skeleton pages; do not invent full article
  content that is absent from the source branch.

The five complete pages retain the source page structure but are localized to current
international product behavior:

- Login uses Google and GitHub rather than QQ and WeChat.
- International activation does not require China real-name verification.
- Subscription wording follows the international limited-free flow and avoids RMB,
  China-only discounts, and China-only purchase requirements.
- Channel examples follow the international order: Telegram, WhatsApp, Discord,
  WeChat, then other supported channels where relevant.
- The domestic RMB subscription screenshot is not reused in international docs.
- English copy is localized for international readers rather than translated word for
  word.

The existing international overview body remains unchanged because it already contains
the equivalent explanatory content. Its Fumadocs description may be updated to match
the new branch-level GEO summary in localized form.

## Navigation and routing

Update both existing docs systems so they remain consistent:

- Add the 36 pages to the international `globalDocs` catalog in
  `frontend/scripts/sync-fumadocs-content.mjs`.
- Extend the international sidebar groups and localized labels in
  `frontend/src/config/docs-sidebar.ts`.
- Add the matching international slug-to-file mappings.
- Regenerate `frontend/next-site/docs-route-manifest.ts` through the existing sync
  script rather than editing generated route arrays manually.
- Preserve existing international-only pages, including Telegram, WhatsApp, Discord,
  WeCom, Lark, Chat, and Using LightVela Safely.

International navigation gains the branch-new task-oriented groups while retaining the
international channel ordering and existing pages.

## SEO scope

Add global page descriptions only for branch-new domestic descriptions that have an
international equivalent:

- `/docs/plans`
- `/docs/credits`
- `/docs/create-first-hermes`
- `/docs/who-is-lightvela-for`

Do not add speculative descriptions for placeholder pages whose source descriptions are
empty. Do not change unrelated SEO entries.

## Images

The branch-new image `20260721-150502-8b3a.webp` contains Chinese UI, RMB prices, and
China-only promotion labels. It must not be referenced by the new international Chinese
or English pages. The first parity version will keep the surrounding explanation but
omit that screenshot until a valid international subscription screenshot exists.

No other branch-new page contains a committed image reference. Recommendation markers
inside the memory article remain text because the source branch did not provide those
images.

## Validation

Validation must prove that the change is international-only and branch-scoped:

1. Confirm all 36 files exist in both `global/` and `en/`.
2. Confirm `en-us` and `zh-sg` route manifests contain the same 36 new slugs.
3. Confirm the domestic markdown files are unchanged.
4. Confirm `configuration/automation` was not duplicated or rewritten.
5. Run the docs sync script and inspect generated metadata and links.
6. Run `pnpm check`.
7. Run the relevant docs tests and `pnpm build:global`.
8. Review the final diff against the branch-only source list to ensure no pre-existing
   domestic/international mismatch was imported.

## Non-goals

- Filling the 31 placeholder pages with new long-form content.
- Refactoring the duplicated docs catalogs into a shared schema.
- Modifying domestic markdown or domestic navigation.
- Copying China-only identity verification, payment, login, channel, or screenshot
  behavior into the international site.
- Synchronizing any domestic/international docs difference that predates the source
  branch.
