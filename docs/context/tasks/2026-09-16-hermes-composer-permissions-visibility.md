## goal
Hide the Codex permission-profile picker for Hermes and any host that declares no permission profiles.

## non_goals
- Do not introduce a Hermes approval-mode control in this change.
- Do not change Hermes approval configuration or the shared AppServer protocol.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-16: Hermes sessions should not display the empty Permissions control.

## interface_refs / data_structure_refs
- `permissionProfile/list` is the AppServer catalog query consumed by `CodexComposer`.
- Hermes bridge returns an empty list because Hermes does not implement Codex permission profiles.

## history_context
- `current_design_refs`: `opencraft/AGENTS.md`, `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`.
- `relevant_evolution`: Hermes exposes `approvals.mode` and session YOLO, not Codex permission profiles.

## acceptance
- A composer without profiles renders no permission picker.
- A composer with profiles keeps the existing accessible Radix menu.
- Focused chat tests and typecheck pass.

## affected_paths
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `opencraft/tests/chat-permission-menu.test.ts`

## required_context
- OpenCraft maintenance guidance and the existing composer selection contract.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | OpenCraft ownership and verification boundary | scope UI-only change |
| `opencraft/packages/codex-composer/src/codex-composer.tsx` | picker owner | preserve existing menu for declared profiles |
| `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol.ts` | Hermes profile catalog behavior | define empty-catalog condition |

## evidence
- Red: `npx tsx --test tests/chat-permission-menu.test.ts` failed because `hasPermissionProfileChoices` did not exist.
- Green: the same test passed after the picker visibility helper and conditional mount were added; the final focused suite has three passing tests, including a regression that the condition wraps the Permissions picker rather than the model menu.
- `npm run typecheck --workspace @opencraft/codex-composer --if-present` and `npm run check:boundaries` passed.
- Workbench typecheck and `npm run build:web` remain blocked before product output by pre-existing unresolved `@opencraft/plugin-lightvela-platform` and related workspace type dependencies; this task does not alter those packages.

## risks
- Hiding a picker during a transient fetch would remove a valid Host control; visibility must be based on declared loaded options.

## validation
- `npx tsx --test tests/chat-permission-menu.test.ts`
- targeted TypeScript check for the composer/workbench packages.

## decisions
- Do not map Hermes approval modes onto incompatible Codex permission-profile names.
- Hide the generic picker whenever the Host supplies no profiles; this makes Hermes capability-honest and keeps the existing accessible menu for Hosts that do supply profiles.

## scan_scope
- `packages/codex-composer/`, `apps/workbench-web/`, `plugins/lightvela-hermes/`.

## scan_output
- Bounded exact source search recorded in this task turn.

## handoff
- Complete in source and focused validation. Runtime visual QA is blocked until the existing workbench workspace dependencies resolve.
