## goal
Prevent Hermes model-switch runtime markers from rendering as user messages in OpenCraft conversations.

## non_goals
- Do not change Hermes server marker persistence or model-switch behavior.
- Do not add a shared AppServer system-message protocol item.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-16: correct the raw `[System: The active model ...]` message shown in an OpenCraft Hermes conversation.

## interface_refs / data_structure_refs
- Hermes persists a role-user row with `display_kind: "model_switch"` for provider-compatible runtime metadata.
- OpenCraft `mapMessages` and `projectTurnItems` own the durable history projection.

## history_context
- `current_design_refs`: Hermes Desktop `apps/desktop/src/lib/chat-messages/hydration.ts` maps `model_switch` to a system presentation.
- `relevant_evolution`: OpenCraft bridge currently treats every Hermes role-user row as user-visible content.

## acceptance
- Model-switch markers create neither an AppServer user message nor a separate turn.
- Adjacent real user messages and assistant results retain their order.
- Focused Hermes projection regression test passes.

## affected_paths
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts`
- `opencraft/tests/lightvela-hermes-plugin.test.ts`

## required_context
- Hermes server marker semantics and Hermes Desktop hydration behavior.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `tui_gateway/server.py@origin/main` | marker producer | preserve durable runtime metadata |
| `apps/desktop/src/lib/chat-messages/hydration.ts@origin/main` | reference projection | avoid raw user rendering |
| `plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts` | OpenCraft projection owner | targeted filtering |

## evidence
- Red: `npx tsx --test tests/lightvela-hermes-plugin.test.ts` produced a standalone user turn for the `model_switch` row.
- Green: the same 76-test Hermes plugin suite passed after filtering only `display_kind: "model_switch"`; `npm run typecheck --workspace @opencraft/plugin-lightvela-hermes --if-present` and `git diff --check` passed.
- Rebuilt signed macOS Preview and started the current `release/preview` bundle as PID 45845; the prior historical Preview processes were left untouched.

## risks
- Broadly filtering display kinds would hide user-visible timeline events; scope only `model_switch`.

## validation
- `npx tsx --test tests/lightvela-hermes-plugin.test.ts`
- focused bridge typecheck.

## decisions
- Hide the marker in OpenCraft until the AppServer can express a source-faithful system timeline item.

## scan_scope
- Hermes server/Desktop marker sources and OpenCraft bridge projection.

## scan_output
- Bounded source inspection recorded in the active task turn.

## handoff
- Complete: current Preview contains the marker projection fix. Reopen the affected Hermes conversation to verify the raw persisted marker is no longer rendered as a user message.
