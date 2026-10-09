---
id: task-international-malay-changelog-20261009
type: task
scope: 国际站 2026 年 10 月马来语产品动态。
triggers: ["changelog", "马来语", "ms-MY"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["frontend/src/pages/marketing/changelog-data.ts", "frontend/src/i18n/locales.json"]
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.0
precedence: task
derived: false
---

# 国际站马来语产品动态

## goal
Add the international site's Malay release to the October 2026 changelog.

## non_goals
- Change Malay locale behavior or documentation.
- Merge, publish, or change production.

## requirement_ids / requirement_refs / requirement_excerpt
- User request (2026-10-09): “国际站增加了马来语版本，更新一下国际站的changelog”.
- Implemented feature: `docs/context/tasks/2026-10-08-international-malay.md` and commits `49a5790e9`, `6802d5abe` on `origin/master`.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/changelog-data.ts`: `buildChangelogGroups` is shared by changelog and Agent overview; preserve the global-only content split.
- `frontend/src/i18n/locales.json`: `ms-MY` / `ms-my` locale registration.

## history_context
- `current_design_refs`: `frontend/src/pages/marketing/changelog-data.ts`, `frontend/src/i18n/locales.json`.
- `relevant_evolution`: October 2026 group already exists; August international group has the Indonesian language release precedent.
- `superseded_refs`: none.

## acceptance
- October 2026 shows a Malay language announcement on the international changelog and recent product updates.
- All published international locales show translated copy; domestic content remains unchanged.
- Frontend `check`, test, and build gates pass.

## affected_paths
- `frontend/src/pages/marketing/changelog-data.ts`
- `frontend/src/i18n/generated/`
- `frontend/src/pages/marketing/__tests__/global-changelog.test.tsx`

## required_context
- `site-environment-routing`, `frontend-product-surface`.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `AGENTS.md@origin/master` | Repository constraints | Isolated worktree and validation |
| `frontend/AGENTS.md@origin/master` | Frontend gates | Lint, type and tests |
| `docs/context/domains/site-environment-routing.md@origin/master` | Site boundary | Global-only entry |
| `docs/context/project/services/frontend.md@origin/master` | Frontend context | Localized content checks |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | i18n neighbor | Check generator and locale test |

## evidence
- `git fetch origin master`; latest master contains `ms-MY`, `ms-my`, independent docs, and the October changelog group.
- User explicitly requested an MR after reviewing the local update; `origin/master` matches the worktree base, Gongfeng authentication succeeds, and this source branch has no existing open MR.
- `pnpm check`: passed; all seven required dictionaries have 3052/3052 translated entries, typecheck baseline has 0 new diagnostics.
- Focused `global-changelog.test.tsx`: 13/13 passed with temporary `127.0.0.1` Vitest host because the execution environment cannot resolve `localhost`.
- `pnpm build:global`: passed; generated `out/ms-my/changelog/index.html` contains the Malay title and description.
- Full Vitest run: unrelated test failures and a worker heap out-of-memory error; stopped after the suite became unstable. Log: `/tmp/lightvela-malay-changelog-test.log`.
- `validate_documentation.py --repo . --format json`: passed, 0 broken first-party links.
- `validate_context.py --build-catalog`: repository-wide validation still reports historical Task Pack errors; no errors mention this task or its checkpoint. Generated catalog changes were discarded because they include unrelated records.
- `check:mono2-agent-console` found i18n generated-copy drift, as expected after adding translation keys. Frontend instructions require committing source first, then syncing the vendored copy in a separate commit.

## risks
- Missing translations would leave raw Chinese or empty copy; mitigate with i18n check and localized rendering test.

## validation
- `pnpm check`, `pnpm test`, `pnpm build`, and focused changelog test.

## decisions
- Add a text-only global entry in the existing October group, matching the Indonesian announcement format.
- Keep the OpenCraft generated-copy synchronization as a separate commit after the frontend source commit.

## scan_scope
- `frontend/src/pages/marketing/`, `frontend/src/i18n/`, and related frontend tests.

## scan_output
- Bounded `rg` searches in the above paths; no standalone scan artifact.

## handoff
- MR submission from `codex/malay-changelog` is authorized; merge and production release remain out of scope.
- Remaining validation limit: full Vitest suite did not finish because of widespread failures and worker memory exhaustion; focused changelog test, frontend check, and international build passed.
- Repository-wide context catalog validation remains red on unrelated historical Task Packs.
