## goal
Remove the chat bubble icon before each conversation in the Agent sidebar session list.

## non_goals
- Change session navigation, actions, pagination, or icons elsewhere in the sidebar.

## requirement_refs
- User screenshot and request on 2026-10-06: remove the icons inside the blue box beside conversation titles.

## interface_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`: the empty default conversation and populated session list render branches.
- `frontend/src/styles.css`: session row spacing and icon styles.

## history_context
- `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` describes the sidebar session list and empty fallback.

## acceptance
- Both default and populated conversation rows show titles without leading chat icons.
- Session selection and the row action menu remain present.
- Frontend checks and focused sidebar test pass.

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`

## required_context
- `frontend-product-surface`, `service-frontend`, `site-environment-routing`.

## context_receipt
| File | Why read | Use |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | Frontend verification boundary | Select checks |
| `docs/context/domains/site-environment-routing.md@2.0.0` | Dual-site route | Shared sidebar applies to both sites |
| `frontend/AGENTS.md@HEAD` | Service rules | Preserve UI conventions and validation |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | Adjacent source/test relationship | Check existing sidebar test |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@HEAD` | Session list design history | Preserve list behavior |

## evidence
- Focused sidebar test: 38 passed with a temporary Vitest config using `127.0.0.1` because host DNS did not resolve `localhost`.
- `pnpm check`: passed; 0 new TypeScript diagnostics.
- `pnpm build`: passed.
- `npm --prefix opencraft run check:mono2-agent-console`: verified 130 files.
- Full Vitest run: unrelated failures occurred, then a worker exhausted its roughly 4 GB heap; run stopped.
- `git diff --check` passed. Staged change-impact check passed with no staged files; touched frontend paths do not match its design-document rules.

## risks
- Text alignment or truncation after removing the icon; check CSS and focused test.

## validation
- `pnpm check`
- Focused sidebar Vitest test (38 passed)
- `pnpm build`
- `npm --prefix opencraft run check:mono2-agent-console`

## decisions
- Remove the two icon nodes and their now-unused session-only CSS. Keep other `MessageSquare` icons.

## handoff
- Local change only; no commit, push, MR, or deployment requested. Full test suite remains unverified because of unrelated failures and a worker OOM.
