## goal
Unify the English copy in the Agent Soul page and its draw, quiz, upload, and edit flows around the product term “Soul”.

## non_goals
- Do not change unrelated Chinese strings, other locale wording, runtime behavior beyond the browser download filename, or historical changelog copy.
- Do not rename internal persona identifiers, analytics events, or routes.
- Do not merge or release. Commit, push, and MR creation were authorized in a follow-up user message.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in this conversation (2026-09-17): review Soul terminology elsewhere, then “改吧”. No external PRD or issue ID provided.
- Follow-up CR on MR !4154 identified 11 active lower-case Soul strings, the unsynced OpenCraft closure, and a downloaded filename mismatch; user authorized the correction.
- Acceptance scope: replace inconsistent `persona` wording in the active English Soul experience; keep `personality` when it describes a person's traits.

## interface_refs / data_structure_refs
- `frontend/src/i18n/index.ts`: Chinese source string resolves through `zh-to-key.json` to the `en-US.json` translation.
- `frontend/scripts/i18n-apply.mjs`: apply translations from Chinese-source-to-English JSON without editing hash keys manually.
- `frontend/openspec/specs/buddy.md`: an uploaded Markdown file may have any `.md` filename; its content is written as Agent `SOUL.md`.

## history_context
- `current_design_refs`: `frontend/openspec/specs/buddy.md`, `docs/context/project/services/frontend.md`, `docs/context/domains/site-environment-routing.md`.
- `relevant_evolution`: The fetched `origin/master` contains the screenshot's subtitle and Soul page strings; the dirty primary checkout is hundreds of commits behind it. This worktree was created from `44a58071d`, then advanced through `3165aca5a` and merged current `origin/master` (`1782bebc1`) before the CR correction.
- `superseded_refs`: none needed.

## acceptance
- Screenshot heading, subtitle, and upload entry use consistent Soul terminology.
- All English user-facing `persona` wording in the active Soul draw, quiz, upload, edit, and status flows is reviewed and changed where it denotes the Agent's Soul.
- Quiz descriptions of the user's own traits retain appropriate `personality` wording.
- Upload copy does not imply the selected file must be named `SOUL.md`.
- Browser downloads are named `SOUL.md`, and both fallback notices accurately name that file in every locale.
- `npm --prefix opencraft run check:mono2-agent-console` passes after generation from the final source commit.
- Focused tests and frontend check/build gates pass, or any unrelated baseline failure is reported precisely.

## affected_paths
- `frontend/src/i18n/generated/en-US.json`
- `frontend/src/pages/marketing/agent-buddy-panel.tsx` and its focused test; generated locale dictionaries for the two filename-source strings.
- `frontend/openspec/specs/buddy.md` and the mechanically generated OpenCraft console closure.
- Focused English-copy regression test under `frontend/src/i18n/__tests__/` if needed.
- This Task Pack and checkpoint.

## required_context
- `frontend-product-surface`, `site-environment-routing`.

## context_receipt
| File | Why read | Decision informed |
|---|---|---|
| `AGENTS.md@44a58071d` | Repository rules | Isolate dirty checkout; run gates; no delivery without authorization |
| `frontend/AGENTS.md@44a58071d` | Frontend rules | Use `pnpm check`/tests/build, no independent lint script |
| `docs/context/project/services/frontend.md@44a58071d` | Routed service context | English locale is a frontend product surface |
| `docs/context/domains/site-environment-routing.md@44a58071d` | Routed locale context | International copy is separate from CN behavior |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@44a58071d` | Relevant adjacency | Verify source, generated dictionary, and a test neighbor |
| `frontend/openspec/specs/buddy.md@44a58071d` | Current Soul contract | Any `.md` filename is accepted; preserve SOUL file semantics |
| `frontend/DESIGN.md@44a58071d` | UI conventions | Copy-only work requires no layout/style changes |

## evidence
- `git fetch --quiet origin master`: local `origin/master` advanced first to `44a58071d`, then to `3165aca5a` before MR delivery.
- `git grep` on master located screenshot subtitle, `Persona Cards`, and `Upload persona file` in the English dictionary.
- `pnpm i18n:extract` found 2,919 source strings and produced no unrelated catalog diff.
- `i18n-apply` updated 42 existing English translations; a bounded scan of the six active Soul UI components found zero remaining user-facing `persona` translations.
- The focused Vitest set passed 7 files / 79 tests; `pnpm check` passed with 0 new TypeScript diagnostics; `pnpm build:global` passed and generated 649 static pages.
- The full `pnpm test` was attempted. It showed failures in unrelated model-config, pricing, automation, docs, and other suites, then stopped producing output; the run was interrupted rather than reported as passing.
- `git diff --check` passed. Generated `next-env.d.ts` and font-subset build noise was removed after confirming both files were clean before the build.
- CR correction: 11 active English Soul terms and two fallback notices are covered by focused regression tests; the two browser download paths and all locale notices now use `SOUL.md`.
- The corrected focused Vitest set passed 4 files / 73 tests. `pnpm check` passed with 0 new TypeScript diagnostics; both `pnpm build:global` (649 pages) and `pnpm build:cn` (103 pages) passed. OpenCraft sync/check follows the final source commit so its revision does not immediately drift.

## risks
- A blanket replacement would corrupt unrelated terms such as operator impersonation or the quiz's user personality profile; use an explicit translation batch.
- The selected upload may be named anything ending in `.md`; avoid the misleading action `Upload SOUL.md`.
- i18n extraction may regenerate unrelated entries; inspect the diff before handoff.

## validation
- Passed: `pnpm check` (includes i18n extract/validate, zh-Hant check, and typecheck), original focused Vitest 79/79, CR-focused Vitest 73/73, `pnpm build:global`, `pnpm build:cn`, and `git diff --check`.
- Not passed: full `pnpm test` (unrelated failures and an eventual stall; stopped after recording the failures).

## decisions
- Product object uses “Soul”; the browser-downloaded file is now also named `SOUL.md` to match Agent state and the cross-locale notices.
- Keep internal `persona` identifiers and historical changelog wording unchanged.

## scan_scope
- `frontend/src/pages/marketing/agent-buddy-*.tsx`, `agent-persona-upload-modal.tsx`, `agent-custom-persona-file-modal.tsx`, and mapped `en-US.json` translations.

## scan_output
- Bounded `t(...)` to English-dictionary mapping was inspected in terminal; no bulk scan artifact saved.

## handoff
- CR corrections target existing MR !4154 from `/Users/pablozhong/codex/lightvela-soul-copy-consistency` on `codex/soul-copy-consistency`. The user authorized commit, push, and MR updates; merge and release remain out of scope. MR !4166 should synchronize its OpenCraft closure after !4154 has merged, to avoid divergent generated manifests.
