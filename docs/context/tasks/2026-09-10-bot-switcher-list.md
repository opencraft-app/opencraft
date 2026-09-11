# Bot Switcher List

## goal
Remove the Bot switcher search field and directly display the available Bot list.

## non_goals
- No change to filtering unavailable Profiles, selecting Bots, scrolling, backend APIs or deployment.

## requirement_refs / requirement_excerpt
- User screenshot request: remove the search Bot input.
- wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md

## interface_refs / data_structure_refs
- AgentSettingsPage visibleBots and PopoverContent; remove botSearch and searchedBots.

## context_receipt
| File | Use |
|---|---|
| frontend/AGENTS.md | Focused verification |
| frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts | Existing switcher guard |
| wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md | Align switcher requirements |

## acceptance
- No search input or search-only empty state; all visible Bots remain selectable in the scrollable popover.
- Latest visual refinement: opaque white background, no list avatars or selected-item background/shadow; retain the current-item checkmark and keyboard focus indication.

## validation
- 34 focused tests passed; diff check passed. Removed unused translations through i18n extraction.
- Frontend check passed: valid i18n and zero new TypeScript diagnostics.

## checkpoint
- stage: implemented locally.
- verified: existing overlay/scrolling and switch handlers retained; source and component tests pass.
- unverified: no real Bot mutation executed.
- next_action: user authorized adding the verified follow-ups to MR !3848; no merge or deployment.

## Latest Visual Checkpoint
- Implemented the subsequent screenshot request; user authorized adding it to MR !3848 with the model Profile isolation fix.
- 29 sidebar regression tests passed; typecheck reports zero new diagnostics (174 existing); diff check passed.
- Header avatar, switching handlers and list scrolling remain unchanged. No authenticated browser verification performed.
