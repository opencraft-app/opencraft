## goal
Show all six single-line queued messages above the OpenCraft chat composer without clipping the last row.

## non_goals
- Change queue ordering, actions, persistence, or mobile layout.
- Merge or release the fix.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshots in this chat: the sixth queued message is partially hidden by the composer; six rows should fit exactly.

## interface_refs / data_structure_refs
- `opencraft/packages/codex-composer/src/queue-tray.tsx`: queue tray and row markup.
- `opencraft/apps/workbench-web/src/styles/app.scss`: tray cap, row height, gap, and padding.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md` queued-message presentation.
- `relevant_evolution`: Current 178px tray cap fits only about five rows because six 30px rows plus gaps and padding require 196px.
- `superseded_refs`: none.

## acceptance
- At six single-line items, the sixth row and its actions are fully visible at the reference desktop viewport.
- Additional rows remain scrollable; compact viewport cap remains 30dvh.
- Run OpenCraft styling, type, and focused queue checks; verify rendered geometry.

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | OpenCraft runtime boundary | Keep change presentational |
| `docs/context/domains/site-environment-routing.md` | LightVela site boundary | No site routing change |
| `docs/context/project/upstream-subtrees.md` | OpenCraft ownership | mono2 is write source |
| `docs/context/project/services/opencraft.md` | Service verification | Choose focused checks |
| `opencraft/AGENTS.md` | Local rules | Require rendered validation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Layout maintenance | Check visible result |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Validation selection | Use component and browser evidence |
| `opencraft/docs/chat-ui-architecture.md` | Current chat design | Preserve queue behavior |
| `opencraft/design/invariants.md` | Composer presentation invariant | Avoid draft or state changes |

## evidence
- User screenshot shows the sixth row behind the composer.
- CSS before change: 178px cap; six rows need 6×30 + 5×1 + 5 + 6 = 196px, plus the tray top border.
- `npx tsx --test tests/chat-composer-queue.test.tsx`: 9/9 passed.
- `npm run typecheck --workspace @opencraft/workbench-web`: passed.
- `npm run build:web`: passed; the first direct Web workspace build was missing the preview-bridge prerequisite, so the documented root build entry was used.
- Local browser with built CSS at 1280×720: tray height 197px, sixth row bottom 350px, tray bottom 357px, composer top 356px; seventh row remains in the scrollable content (scrollHeight 234px).

## risks
- Small viewports may still show fewer than six rows due to the retained 30dvh cap; queue stays scrollable.

## validation
- Focused chat composer queue test, Web typecheck, style lint/build, browser geometry.

## decisions
- Increase only the desktop queue tray pixel cap to 197px so six rows and the border fit; keep viewport cap and scrolling.

## scan_scope
- `opencraft/packages/codex-composer/src/queue-tray.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/chat-composer-queue.test.tsx`

## scan_output
- Bounded `rg` and file reads in the current task.

## handoff
- CSS change is verified in a synthetic browser layout using the production build stylesheet. Authenticated LightVela conversation and packaged Electron were not used. Commit, push, and MR submission were subsequently authorized; the MR records delivery status.
