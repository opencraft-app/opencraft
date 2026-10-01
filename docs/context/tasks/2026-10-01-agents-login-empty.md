## goal
Restore visible content on the domestic `/agents` page after login when no Agent is visible and the client subscription state is false.

## non_goals
- Change login, subscription, Bot creation, or deployment behavior.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot, 2026-10-01: after login, `/agents` shows only the LightVela header.

## interface_refs / data_structure_refs
- `OpenClawProvider`: `bots`, `botsLoading`, `passesLoading`, `isSubscribed`.
- `AgentSettingsPage`: overview and empty-state render conditions.

## history_context
- `current_design_refs`: `frontend/openspec/specs/auth.md`, `frontend/openspec/specs/bot.md`.
- `relevant_evolution`: domestic `/agents` defaults to overview; fleet overview is subscription gated.
- `superseded_refs`: none.

## acceptance
- An authenticated session with no visible Agent and `isSubscribed=false` sees the existing empty state and creation entry on `/agents`.
- Subscribed overview and creation onboarding keep their existing render paths.

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-create-intent.test.tsx`

## required_context
- `site-environment-routing`.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | Domestic site boundary | Scope this fix to the current domestic route behavior. |
| `frontend/AGENTS.md` | Frontend service rules | Choose frontend tests and checks. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | Frontend neighbors | Inspect adjacent route test and OpenSpec references. |
| `frontend/openspec/specs/auth.md` | Authentication state contract | Keep login behavior unchanged. |
| `frontend/openspec/specs/bot.md` | Bot state contract | Keep Bot behavior unchanged. |

## evidence
- Production `/agents` main section rendered empty with `lv-agent-empty-page`; the same session on `/agents/channels` rendered the existing empty state and New button.
- The overview condition requires `isSubscribed`; the empty-state suppression did not.
- Focused regression test: 1 passed; adjacent empty-page test: 3 passed.
- `pnpm check`: passed with 0 new TypeScript diagnostics; `pnpm build:cn`: passed.

## risks
- A zero-Bot subscribed account must continue to show fleet overview; retain the suppression when `isSubscribed` is true.

## validation
- Focused Agent page render test and adjacent empty-page test passed; `pnpm check`, `pnpm build:cn`, and `git diff --check` passed.
- Full `agent-settings-create-intent.test.tsx` run exhausted the Vitest worker heap on an existing Bot render case; the new regression test passes alone.
- No standalone `pnpm lint` script exists in `frontend/package.json`.

## decisions
- Add the missing subscription condition to the empty-state suppression; reuse the existing empty UI.

## scan_scope
- `frontend/src/pages/marketing/`, `frontend/next-site/`, `frontend/openspec/`.

## scan_output
- Bounded `rg` outputs in this task's command history.

## handoff
- Local fix validated in an isolated worktree; commit, push, and MR submission authorized on 2026-10-01. No merge or deployment authorized.
