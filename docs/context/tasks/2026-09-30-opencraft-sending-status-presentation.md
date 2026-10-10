# OpenCraft sending status presentation and message flash diagnosis

## goal

Do not show a transient `Sending` status line under outgoing user messages, and keep the outgoing bubble continuously mounted through the optimistic-to-authoritative handoff.

## non_goals

- No message-delivery protocol change, preview replacement, or service restart in this step.

## requirement_ids / requirement_refs / requirement_excerpt

- User report in this conversation: ordinary outgoing message bubbles flash; first requested change is that `Sending` should not be displayed.

## interface_refs / data_structure_refs

- `UserMessageTimelineBlock.deliveryStatus` retains transport state.
- `deriveUserMessageWebLayout.hasStatus` and `UserMessageStatusRow` own Web presentation only.
- `ReplicaConversationRuntime` owns optimistic submission and authoritative handoff.
- Chat Core owns stable display keys; protocol Turn and Item IDs remain canonical for navigation, measurements, commands and anchors.

## history_context

- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: the running preview has build ID `20260929145623-combined-queue-paste`; newer repository CSS changes have not replaced it.
- `superseded_refs`: none.

## acceptance

- Outgoing ordinary text has no `Sending` status line or its layout slot.
- Failed, unknown and blocked delivery still have visible feedback.
- The delivery state itself remains available to runtime consumers.
- A Turn receipt, an empty Turn, Turn.params, and the eventual server UserMessage all show exactly one outgoing bubble with the same display block/frame/React-row keys.

## affected_paths

- `opencraft/apps/workbench-web/src/components/conversation/user-message.tsx`
- `opencraft/apps/workbench-web/src/components/conversation/user-message-layout.ts`
- `opencraft/tests/workbench-user-message-layout.test.ts`
- `opencraft/packages/chat-runtime/src/replica-conversation-runtime.ts`
- `opencraft/packages/chat-core/src/builtin-projectors.ts`
- `opencraft/packages/chat-core/src/projection.ts`
- `opencraft/packages/chat-core/src/timeline-turns.ts`
- `opencraft/apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx`
- `opencraft/tests/chat-runtime.test.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context / context_receipt

- Root and OpenCraft `AGENTS.md`: task scope, service owner and mapped design documentation.
- OpenCraft maintenance skill and verification reference: diagnose from source/runtime evidence; separate UI result from running preview.
- ChatUI and platform architecture, user-message source, Chat Core projection, and navigation source: transport state versus visible status and display identity versus canonical Turn locator.
- Context router returned no matching Pack; bounded exact searches covered the Web user renderer and optimistic runtime.

## evidence

- The user clarified that an ordinary text bubble flashes, so the code-fence sizing change cannot explain the general symptom.
- A held-receipt regression reproduced Turn-row remount at the receipt boundary. Source inspection also showed that an empty authoritative Turn removed the optimistic bubble before its UserMessage arrived.
- The runtime now retains the optimistic display item inside an empty acknowledged Turn and retires it only when authoritative input or Item content is visible. Chat Core keys the message block, user frame, and React row by the client message ID while preserving protocol Turn/Item IDs and the virtualizer's canonical Turn locator.
- The running preview reports build ID `20260929145623-combined-queue-paste`; its emitted JavaScript contains both the visible `Sending` branch and optimistic/Composer message IDs.
- Focused user-message layout tests: 9/9 passed. The held-receipt handoff test first failed on a changed frame/row key; after the fix, it covers receipt, empty Turn, client ID without input, Turn.params, Item-only and params+Item phases with one stable bubble.
- Full selected Chat/Composer suite passed (439 tests); Web and Chat Runtime TypeScript typechecks, platform-boundary check and isolated Web build passed. The emitted new build no longer has the user-message `Sending` branch and retains failure/unknown indicators.
- `git diff --check`, repository documentation validation, and staged change-impact check passed. The staged check saw no staged files, so it does not establish review of the unstaged worktree.

## risks

- This fixes the confirmed display-identity transitions, but live mobile frame-by-frame verification still requires an updated preview. Legacy sources that omit client message IDs need separate assessment if observed.

## validation

- Focused layout, Chat Core and Chat Runtime tests, Web and Chat Runtime typechecks, platform-boundary check, isolated Web build, `git diff --check` and repository documentation validation; actual phone presentation requires preview replacement and client verification.

## decisions

- Keep `sending` in the runtime model; suppress only its Web user-message status projection. Treat visible message content, not a Turn ID alone, as handoff acknowledgement.

## scan_scope

- User-message Web renderer/layout, optimistic submission reconciliation, Turn normalization, virtualizer keys, relevant tests and current preview build ID.

## scan_output

- Bounded source inspection; no bulk artifact.

## handoff

- Source change and automated checks complete. Current preview remains unchanged and active; real phone presentation still needs an updated preview and client verification. No commit, push or service restart was performed.

## checkpoint

### stage

Implementation and automated verification complete; user authorized replacing the self-hosted preview. Candidate package is built and smoke-tested; cutover and reconnection verification remain.

### verified

- A held-receipt test reproduced unstable presentation keys before the fix and now passes through six handoff phases.
- Canonical `turnKey` remains the authoritative Turn ID for navigation and measurement; React row, user Frame and message block use the stable client message ID.
- Selected Chat/Composer tests, typechecks, platform boundary check, isolated Web build, documentation validation and whitespace check passed.
- The current owner is `opencraft-combined-20260929-preview.service` on port 80, using build `20260929145623-combined-queue-paste` and data root `/var/lib/opencraft-preview-codex-20260923173651`.
- Candidate `20260930-bubble-handoff` uses the prior package's unchanged `runtime/server.mjs` (SHA-256 `5c147f98ab2a4a04def54c52e439095c6b2db964f447764208b8f6771d81a5e5`) and a fresh headless Web build from the current dirty OpenCraft checkout. The Web build therefore also contains other current uncommitted Web changes; it is not a narrowly cherry-picked source patch.
- Candidate passed isolated port-10081 health, Web, and Codex AppHost checks, plus full headless Linux archive smoke with manifest checks and both DSH/Codex initialization. The old package and live data directory remain untouched.

### unverified

- The current phone page still runs the previous preview. Real touch-device frame behavior after replacement has not been observed.
- Compatibility of all other current dirty Web features with the unchanged server runtime is not exhaustively proven by smoke tests.

### discard

- The earlier idea of changing `TimelineTurnView.turnKey` itself was rejected because navigation sources use it as a canonical Turn locator.

### restore

- Preserve the dirty worktree. Relevant edits are in Chat Core projection/turn helpers, Chat Runtime reconciliation, Web virtualizer row key, user-message status presentation, associated tests and this design/task documentation. The candidate is staged under `/data/opencraft-preview-bubble-XJPD7BtG`; the old package remains at `/data/opencraft-preview-combined-20260929-xsxCJD`.

### next_action

- Launch the independent systemd cutover script, reconnect, verify live PID/cgroup/cwd/runtime hash/build ID/health, then ask the user to verify the phone-visible send sequence.
