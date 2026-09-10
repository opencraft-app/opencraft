# Fixed shell navigation entrances

## goal
Model and connect pinnable application/account contents while the split entrance remains physically fixed at the Shell's bottom-left.

## non_goals
- No release, commit, push, backend changes or new Home bootstrap semantics.
- Do not synthesize business navigation destinations from mockup labels.
- No replacement of conversation state, composer, or sidebar spring animation.

## requirement_refs / requirement_excerpt
- Current user conversation: buttons stay in place; left apps/right account; app Pin shows app column beside conversation column. Icons overlap only inside the entrance; actual navigation remains a vertical list.

## interface_refs / data_structure_refs
- `opencraft/packages/workbench-runtime/src/shell-navigation.ts`: pure state and responsive projection.
- `opencraft/apps/workbench-web/src/components/app-shell.tsx`: sole physical geometry owner.
- `opencraft/packages/extension-contract/src/index.ts`: existing NavigationContribution/View targets.

## history_context
- current_design_refs: `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- relevant_evolution: current Sidebar owns account UI; current AppShell owns one left rail and right-panel geometry.
- superseded_refs: earlier mockups with a moving footer, watch-grid contents or an extra toolbar switch are rejected.

## acceptance
- Footer node, parent, bounding box and focus identity remain stable during Pin transitions.
- App/account preferences independent; transient dismiss does not unpin.
- Width pressure affects presentation, not saved preference; expanding restores dock.
- Existing extension actions and account provider reused, no mock actions.
- Shared model tests, Web typecheck, geometry browser smoke and workspace gate.

## affected_paths
- `opencraft/packages/workbench-runtime/src`, `opencraft/apps/workbench-web/src`, `opencraft/tests`, architecture documentation.

## required_context
- frontend-product-surface routing; OpenCraft platform ownership.

## context_receipt
| File | Reason | Use |
| --- | --- | --- |
| `AGENTS.md` | Repo boundaries | No external writes; preserve unrelated dirty task document |
| `opencraft/AGENTS.md` | Workspace authority | mono2 only; gate required |
| `docs/context/project/services/frontend.md` | Router must_read | Keep frontend/generated code out of scope |
| `opencraft/docs/platform-architecture.md` | Platform boundary | Shared pure semantics, renderer-owned placement |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | UI neighbor | Inspect local sidebar tests and styling |
| `docs/engineering/domains/agent-gateway-runtime.md` | Mapped formal design | Preserve conversation runtime lifetime |
| `docs/context/tasks/TASK-TEMPLATE.md` | Task state | This record |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | Recovery | Checkpoint below |

## evidence
- Worktree initially has only unrelated `2026-09-10-opencraft-modal-ownership.md` modified.
- Sidebar and AppShell source inspected; no current pin model.

## risks
- Extra rail must participate in header/browser geometry. Fixed footer must not move with rail animation or cover bottom content.
- Preserve account errors, focus, and async provider behavior; delegate popup behavior to Radix.

## validation
- Pending implementation checks.

## decisions
- Footer is a persistent Shell sibling of the animated row, never a rail child.
- Pin preference is independent of responsive dock availability and conversation location.
- No invented Home/Skills destinations where current contributions do not supply them.

## scan_scope / scan_output
- Bounded AppShell/Sidebar, account provider, extension projections and local test files.

## handoff
- In progress. Not committed or deployed.

## checkpoint
- stage: shared state model written; Web adapter next.
- verified: existing geometry and account ownership.
- unverified: rendered Pin transitions, Expo visual adapter.
- discard: moving-button proposals.
- restore: this pack and files above.
- next_action: connect fixed-footer shell slots.
