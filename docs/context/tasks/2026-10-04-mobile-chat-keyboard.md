## goal
Keep the domestic mobile Chat composer visible above the iOS keyboard after the input receives focus.

## non_goals
- Change the desktop or international Chat layout.
- Change the OpenCraft composer behavior or deploy the fix.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshots from 2026-10-04: the composer is visible before focus; after the iOS keyboard opens, only the caret remains visible in a white area.

## interface_refs / data_structure_refs
- `window.visualViewport.height` and `offsetTop` give the visible viewport bottom in layout viewport coordinates.
- `AgentChatMigrationSurface` fills the height supplied by `AgentSettingsPage` on domestic Chat.

## history_context
- `current_design_refs`: `frontend/src/styles.css`, `frontend/src/pages/marketing/agent-settings-page.tsx`, `opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx`.
- `relevant_evolution`: the mobile Chat shell used `100dvh`; prior desktop and mobile viewport checks did not cover a real soft keyboard.
- `superseded_refs`: none.

## acceptance
- On mobile domestic Chat, visual viewport resize and pan move the composer to the visible bottom.
- Closing the keyboard restores the full height; international and desktop layouts retain their existing sizing.
- Focused test, frontend check, build, and diff check pass.

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-chat-visual-viewport.ts`
- `frontend/src/pages/marketing/__tests__/agent-chat-visual-viewport.test.ts`
- `frontend/src/styles.css`

## required_context
- Router found no Domain Pack for this task. The bounded exact search matched the frontend Chat shell and OpenCraft embed.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `frontend/AGENTS.md@HEAD` | Service boundary and gates | Scope and validation |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | Frontend neighbors | Checked OpenSpec and adjacent test |
| `frontend/openspec/specs/bot.md@HEAD` | Composer design pointer | Confirmed the local workbench composer is separate |
| `opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx@HEAD` | Embedded sizing | Confirmed the element fills its host |

## evidence
- The original mobile shell used `100dvh` with clipped overflow; OpenCraft host and composer are height constrained.
- The focused viewport and existing navigation tests passed (8/8). `pnpm check` passed with 0 new TypeScript diagnostics; `pnpm build:cn` passed.
- Vitest needed temporary `127.0.0.1` binding because this host cannot resolve `localhost`; the original config was restored after the run.
- The change is local only. A physical iOS keyboard check is still pending.

## risks
- iOS embedded browsers can differ in how they report visual viewport pan. Keep the change scoped to the domestic mobile Chat shell and request physical-device confirmation after delivery.

## validation
- `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-chat-visual-viewport.test.ts`
- `pnpm check`
- `pnpm build:cn`
- `git diff --check`

## decisions
- Bind the host height to the visual viewport bottom; the composer stays owned by OpenCraft.

## scan_scope
- `frontend/src/pages/marketing`, `frontend/src/styles.css`, and the OpenCraft embedded Chat entry.

## scan_output
- Bounded exact searches in the active worktree; no saved broad scan.

## handoff
- The user authorized commit, push, and an MR for this fix together with the mobile composer height change. Physical iOS keyboard verification remains pending; merge and release are outside this handoff.
