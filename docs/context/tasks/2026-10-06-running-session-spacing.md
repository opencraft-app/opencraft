## goal
Balance the spacing among the title, running indicator, and action menu in domestic Agent sidebar conversation rows.

## non_goals
- Change running state detection, conversation content, or other sidebar navigation.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot, 2026-10-06: the running indicator touches the title and sits too far from the `...` action.
- Follow-up screenshot, 2026-10-06: the spinner and `...` icon in the selected conversation row both appear slightly below the vertical center.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-settings-page.tsx`: `isRunning` adds the row class and indicator.
- `frontend/src/styles.css`: running title reserve, indicator, and action anchor layout.

## history_context
- `current_design_refs`: current sidebar markup and CSS.
- `relevant_evolution`: the current worktree already contains sidebar icon removal and unread marking; preserve them.
- `superseded_refs`: none.

## acceptance
- The indicator has visible space on both sides, and the menu stays aligned and clickable.
- The spinner and action button share the conversation row's vertical center at desktop and mobile row heights.
- Domestic 5174 preview continues to load real conversations.

## affected_paths
- `frontend/src/styles.css`

## required_context
- `service-frontend`, `site-environment-routing`; router also returned `identity-access` because of the word “session.”

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `frontend/AGENTS.md` | Service constraints | Frontend validation commands |
| `docs/context/project/services/frontend.md` | Frontend pack | UI boundary |
| `docs/context/domains/site-environment-routing.md` | Domestic preview | Site boundary |
| `docs/context/domains/identity-access.md` | Router must-read | No auth changes |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Adjacent test check | Checked sidebar test neighbor |
| `docs/context/tasks/TASK-TEMPLATE.md` | Task contract | Pack structure |

## evidence
- The title reserves 52px while the absolutely positioned 14px spinner and 32px menu use a 4px gap; this leaves the title almost touching the spinner but more space toward the menu glyph.
- At the live sidebar width, the updated CSS yields approximately 10px from the title boundary to the spinner and 9px from the spinner to the `...` glyph. Chrome shows five real conversations and the embedded workbench after restart; the action menu opens and closes.
- Follow-up root cause: desktop session rows have a 32px minimum height while the absolutely positioned action anchor had a fixed 36px height starting at `top: 0`, placing both icons 2px below the row's center.

## risks
- Long titles truncate earlier by 8px while running; only running rows are affected. Revert the two CSS values if cramped.

## validation
- `pnpm check`, focused sidebar tests, `pnpm build:cn`, local browser review, `git diff --check`.
- Completed: `pnpm check` (0 new TypeScript diagnostics), 38/38 focused sidebar tests, `pnpm build:cn`, documentation validation (0 broken first-party links and 0 warnings), `git diff --check`, local `/agents/chat/` and OpenCraft script HTTP 200.
- The focused Vitest command needed an ephemeral config with Vite host and JSDOM URL set to `127.0.0.1`, because this host does not resolve `localhost`. The config was removed after the test.
- Follow-up vertical alignment: `pnpm check` passed (0 new TypeScript diagnostics), `git diff --check` passed, and the existing 5174 listener remains active. The browser security policy blocked automated access to the local preview, so this follow-up is not visually verified in-browser.

## decisions
- Reserve 60px for a running row and use zero flex gap in the action anchor; the 32px menu button itself retains its internal spacing.
- Follow-up: make the action anchor `height: 100%` so its flex alignment uses the actual row height; retain the existing horizontal spacing and button sizes.

## scan_scope
- `frontend/src/styles.css`, adjacent sidebar markup and tests.

## scan_output
- Bounded `rg` results reviewed; no separate artifact.

## handoff
- Local-only CSS adjustment with the 5174 preview running; no commit, push, MR, or release requested. A live running indicator was unavailable at final browser review because the session had finished.
