## goal
Project Hosted Rooms whose member profiles were deleted as readable historical conversations and reject every write path.

## non_goals
- Do not alter Hermes room rosters or automatically disband existing rooms.
- Do not recreate deleted profiles or mutate the target instance data.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-16: frozen-roster groups whose profile is gone should remain read-only rather than break the Bots page.

## interface_refs / data_structure_refs
- Hermes Room roster is immutable (`groupMembership: false`).
- `AppServerBotConversationDescriptor` and `BotConversationDescriptor` require an explicit read-only state.
- Hermes group bridge owns durable descriptor, participant, message and write projection.

## history_context
- `current_design_refs`: Hermes Desktop orphan-member hygiene preserves identity and marks a missing source.
- `relevant_evolution`: target room `666, 9999` persists deleted profiles and currently causes `Bot profile not found` during descriptor construction.

## acceptance
- Missing-profile rooms list and read with historical participant names.
- They project as read-only and reject send, cancel, approval, and update writes.
- Normal groups remain writable.

## affected_paths
- `opencraft/packages/appserver-protocol/src/bot-conversations.ts`
- `opencraft/packages/bot-conversation/src/model.ts`
- `opencraft/packages/bot-conversation-appserver/src/source.ts`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/{bot-protocol-handler,group-conversations}.ts`
- `opencraft/plugins/bot-chat/src/bot-chat-view.tsx`

## required_context
- Hermes Hosted Room protocol, OpenCraft Bot domain model, and Desktop orphan-member reference.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `apps/desktop/.../hygiene.ts@origin/main` | orphan identity semantics | preserve identity without route crashes |
| `group-conversations.ts` | hosted room projection owner | add tolerant read-only route |
| `bot-conversation/src/model.ts` | UI-facing conversation state | carry read-only state |

## evidence
- Red: a room with a deleted `retired-profile` threw `Bot profile not found` from Hosted Room descriptor construction.
- Green: `tests/hermes-group-conversations.test.ts`, `tests/chat-bot-appserver.test.ts`, and `tests/bot-directory.test.ts` passed (15 tests); `tests/lightvela-hermes-plugin.test.ts` passed (76 tests).
- Typechecks passed for appserver protocol, Bot domain, Bot AppServer source, Bot Chat, and Hermes bridge; platform boundary check and `git diff --check` passed.
- Rebuilt and signature-verified the macOS Preview; current Preview main process is PID 30724. Historical Preview PID 41607 was left untouched.

## risks
- A missing member must not be silently replaced by another Bot; only its durable display identity is retained.

## validation
- Focused Hermes group and Bot conversation tests, plugin typecheck, boundaries check, and Preview rebuild.

## decisions
- Read-only is a conversation lifecycle state, not an implicit Bot substitution or a roster mutation.

## scan_scope
- Hosted Room bridge, Bot protocol/source/view, Hermes Desktop orphan-member reference.

## scan_output
- Bounded source inspection recorded in task turn.

## handoff
- Complete: deleted-profile Hosted Rooms are projected as read-only historical conversations. Reopen the affected group in the current Preview to verify its history remains readable and its composer is disabled.
