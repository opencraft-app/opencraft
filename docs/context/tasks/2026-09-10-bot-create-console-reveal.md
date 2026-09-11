# Bot Creation Console Reveal

## goal
Reuse the existing show() console helper to reveal additional Bot creation.

## non_goals
- No public rollout, backend changes or deployment.
- Do not bypass feature flags, capacity checks or initial Agent creation.

## requirement_refs / requirement_excerpt
- User requested the same show() behavior as existing hidden navigation tools.
- wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md

## interface_refs / data_structure_refs
- installOpenClawConsoleHelpers, showHiddenAgentTools, showCreateBotEntry, canCreateBot.

## history_context
- Current baseline c43e86592 includes diagnostics adaptation in MR !3848.
- Previously the additional Bot entry was hard-disabled after !3836.

## acceptance
- Hidden by default, revealed by show(), stays revealed on sibling switch, resets on remount.
- Feature and capacity gates remain effective; revealed entry opens the creation dialog.

## context_receipt
| File | Reason | Use |
|---|---|---|
| frontend/AGENTS.md | Frontend rules | Focused tests and type check |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Existing adjacency | Console helper and neighboring tests |
| wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md | Product boundary | Update temporary reveal behavior |

## evidence
- Context router returned no pack for frontend agent-settings-page hidden show console Bot creation.
- Bounded source search found hard-disabled showCreateBotEntry and existing helper callback.

## decisions
- Share existing nonpersistent state instead of a new console API or storage key.

## validation
- Four focused suites passed (45 tests), covering reveal, dialog opening, sibling switch, remount and feature/capacity gates. Diff check passed.
- pnpm check passed with zero new TypeScript diagnostics; i18n checks passed. Explicit path impact check passed; local /agents/ returned HTTP 200.
- Final sidebar follow-up verification: 47 focused tests passed, pnpm check passed, CN build passed (96 pages), staged impact and documentation checks passed.

## handoff
- User authorized submission of the sidebar follow-ups to existing MR !3848; Beijing preview process configuration is excluded.

## checkpoint
- stage: implemented and focused tests passed.
- verified: existing console helper toggles the shared state; no persisted flag or new API.
- unverified: no real Bot created; backend creation behavior unchanged.
- next_action: submit the authorized follow-ups and verify remote MR/CI state without merging.
