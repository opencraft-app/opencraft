## goal
Align the embedded Chat header divider with the LightVela sidebar header divider on desktop.

## non_goals
- Change the global OpenCraft header or publish the page.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and request on 2026-10-01: move the right divider up to match the left divider.

## interface_refs / data_structure_refs
- `--app-shell-main-content-frame-top-offset` positions the Chat content frame.
- The divider is the top border of `.main-content-frame[data-app-shell-thread-edge-divider="true"]`.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `docs/context/project/services/opencraft.md`.
- `relevant_evolution`: Embedded workbench uses the LightVela 68px header height.
- `superseded_refs`: none.

## acceptance
- On desktop, the left and right divider top edges have the same viewport Y coordinate.
- Other OpenCraft surfaces keep their existing header geometry.

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, OpenCraft and frontend service context.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | Agent UI domain | Scope |
| `docs/context/domains/site-environment-routing.md` | Domestic site integration | Scope |
| `docs/context/project/upstream-subtrees.md` | OpenCraft ownership | Avoid generated files |
| `docs/context/project/services/opencraft.md` | Service route | Validation |
| `docs/context/project/services/frontend.md` | Host page route | Header comparison |
| `opencraft/AGENTS.md` | Service instructions | Verification |
| `opencraft/docs/chat-ui-architecture.md` | Embedded canvas ownership | Keep change in OpenCraft presentation |
| `frontend/AGENTS.md` | Host page instructions | Integration boundary |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | UI maintenance | Minimal scoped fix |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | UI validation | Browser and test checks |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Neighbor check | Frontend integration |

## evidence
- Before: left header bottom 68px with 1px border; embedded frame top 68px with 0.5px top border.
- After: live Chrome DOM reports both divider top edges at 67px. Local preview endpoints on 5174 and 10002 return HTTP 200.
- `npm run typecheck --workspace @opencraft/workbench-web` passed.
- `npm run test:shell-space` passed (17/17).
- `npm run check:mono2-agent-console` passed (130 files).
- `npm run build:embedded-workbench:release` passed; Vite emitted existing bundle size/dynamic import warnings.
- `git diff --check` passed.

## risks
- The embedded Chat content frame moves up 1px; verify desktop presentation and draft behavior.

## validation
- `git diff --check`.
- OpenCraft workbench typecheck and shell space test.
- Live local desktop browser geometry and visual check.

## decisions
- Scope the offset to embedded Chat frames with a visible divider and inactive edge scroll.

## scan_scope
- `frontend/src/styles.css`, `opencraft/apps/workbench-web/src/styles/app.scss`, embedded workbench element.

## scan_output
- Bounded `rg` and DOM geometry results in this task conversation.

## handoff
- Local preview is running and visually checked. User requested an MR update; no merge or release requested.
