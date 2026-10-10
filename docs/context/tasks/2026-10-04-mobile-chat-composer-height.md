## goal
Reduce the domestic mobile Chat composer height while keeping its controls usable and its keyboard placement intact.

## non_goals
- Change desktop composer density or the international AgentChat surface.
- Change draft, submit, attachment, or voice behavior.
- Merge, publish, or deploy the change.

## requirement_ids / requirement_refs / requirement_excerpt
- User follow-up on 2026-10-04: "移动端的话，这个输入框的高度，调小一些".
- Initial keyboard screenshots and the local viewport fix are recorded in `2026-10-04-mobile-chat-keyboard.md`.

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx` injects CSS into the embedded Shadow DOM.
- `.codex-composer-editor` is the editable region; `.codex-composer-footer` owns action controls.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: the embedded editor had a 74px minimum at every width; the host viewport fix addresses keyboard visibility separately.
- `superseded_refs`: none.

## acceptance
- At phone width, the embedded editor minimum shrinks to 48px and supports two 24px lines of input.
- At desktop width, the 74px minimum and footer controls remain unchanged.
- The built embedded bundle contains the responsive rule and frontend integration checks pass.

## affected_paths
- `opencraft/apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Router path match: `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@HEAD` | OpenCraft ownership | Kept the change in the Chat renderer |
| `docs/context/domains/site-environment-routing.md@HEAD` | Domestic/global boundary | Scoped the visible effect to the domestic embedded surface |
| `docs/context/project/upstream-subtrees.md@HEAD` | Source ownership | Mono2 remains the sole OpenCraft write source |
| `docs/context/project/services/opencraft.md@HEAD` | Service and validation | Chose embedded build and focused checks |
| `opencraft/AGENTS.md@HEAD` | Local service rules | Required real component evidence |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@HEAD` | UI maintenance procedure | Preserved editor and footer ownership |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | Composer ownership | Kept draft and submit behavior outside the CSS change |

## evidence
- The shared editor default is 26px; embedded CSS raises it to 74px across widths. Mobile touch input uses a 24px line height.
- `npm run typecheck --workspace @opencraft/workbench-web`, focused presentation test (1/1), and `npm run build:embedded-workbench:release` passed.
- The built component's Shadow DOM computed style in a local browser was 48px at a 390px viewport and 74px at a 1280px viewport. The containing composer shell measured 101px versus 127px, while the footer stayed 39px.
- The browser preview used synthetic text and controls to measure the built CSS; it did not connect a real Host or open a software keyboard.
- The staged change-impact gate and documentation validation passed; the files were returned to unstaged local changes after the gate.

## risks
- A browser width check cannot reproduce the iOS software keyboard; keep real-device validation separate from build and browser evidence.

## validation
- Focused OpenCraft test and typecheck.
- Embedded bundle build and mobile/desktop computed-style check.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`.
- `git diff --check`.

## decisions
- Use a phone-width override on the embedded editor only, leaving the shared composer and footer untouched.

## scan_scope
- `opencraft/apps/workbench-web/src/embedded-chat/`, `opencraft/apps/workbench-web/src/styles/app.scss`, and adjacent embedded tests.

## scan_output
- Bounded exact searches in the active worktree.

## handoff
- The user authorized commit, push, and an MR for this change together with the mobile keyboard fix. Physical iOS keyboard verification remains pending; merge and release are outside this handoff.
