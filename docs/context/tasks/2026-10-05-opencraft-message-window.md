# OpenCraft message-window regression

## goal
Fix messages disappearing immediately after submission until scrolling or switching conversations.

## non_goals
- No embedded keyboard changes, protocol mutation, preview replacement, deployment, or task-card workflow.
- No inclusion of other shared-worktree changes.

## requirement_refs / requirement_excerpt
- User report: OpenCraft Web Safari; newly sent messages blank, scroll/switch restores them; inspect recent changes.
- Latest authorization: commit, push and normally merge into master.

## interface_refs / data_structure_refs
- `timeline-virtualizer`: `reconcileRenderedRangeForEntries`, measured geometry and layout reconciliation.
- `chat-core`: `TimelineTurnView`, primary user-message `clientId` versus canonical `turnKey`.
- Web `VirtualizedConversationTurns`: stable row identity and viewport layout invalidation.

## history_context
- Current design: `opencraft/docs/chat-ui-architecture.md` and `docs/engineering/domains/agent-gateway-runtime.md`.
- Recent uncommitted preview window reconciliation retained only surviving canonical IDs; acknowledging an optimistic final row could exclude that slot. The viewport refresh only observed entry count, so natural scroll policy did not recover until a scroll event.
- Clean delivery base: `efc37fe08`, including latest ordered-response-segment changes; this patch does not replace them.

## acceptance
- Three consecutive sends retain the exact row and user-bubble DOM through canonical acknowledgement under natural and response-placement policies.
- Streaming remains mounted without scrolling. Acknowledgement while reading history preserves its anchor within 2px.
- History insertion retains the last mounted row; no ResizeObserver warnings.

## affected_paths
- `opencraft/packages/chat-core/src/timeline-turns.ts`
- `opencraft/packages/timeline-virtualizer/src/`
- `opencraft/apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx`
- `opencraft/tests/chat-timeline-virtualizer.test.ts`, scroll fixture and smoke script.
- Formal design documents above.

## required_context / context_receipt
- Root and OpenCraft `AGENTS.md`: ownership, clean delivery and verification boundaries.
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md`: preserve continuity and test real DOM without forced scroll/remount.
- `opencraft/docs/chat-ui-architecture.md`: timeline and viewport ownership.
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`, `frontend/vitest.config.ts`: bounded adjacent test configuration check.
- Context route query `opencraft message blank conversation rendering scroll virtualization` had no match; bounded exact search then located the virtualized Conversation and recent window diff.
- Root Task/Checkpoint templates: scoped delivery record.

## decisions
- Keep both original anchored slots and surviving mounted IDs during the intermediate window handoff.
- Use primary user client identity for DOM and measured-height transfer, not as a new protocol ID.
- Observe complete layout invalidation, rather than waiting for entry count or platform scroll.

## risks
- Height transfer must not override an observed authoritative height or transfer between unrelated messages; unit coverage required.
- Real Safari/WebKit verification remains unavailable in the Linux test environment. Chromium replay does not establish Safari acceptance.
- Normal MR review gates may prevent merge; do not bypass them.

## validation / evidence
- Shared-source model, chat suite, type, boundary and real Conversation Chromium replay passed before isolated delivery.
- Isolated latest-master verification passed: 60 virtualizer tests; complete chat/composer test selection; Web, chat-core and timeline-virtualizer typechecks; typography/platform-boundary check; complete real Conversation Chromium scroll replay; Web release build.
- Chromium replay retained the exact latest row/bubble on three consecutive acknowledgements under both policies, streamed without scrolling, preserved the history-reading anchor within 2px, and reported zero ResizeObserver warnings. Existing follow, completion, history-fill and restore sequences also passed.
- Release build completed with chunk-size and ineffective-dynamic-import warnings; these are not a Safari device acceptance result.

## scan_scope / scan_output
- Exact changed files only. No credentials, profiles, generated build trees or machine paths are deliverables.

## handoff / checkpoint
- Stage: isolated latest-master checks passed; Git delivery next.
- Verified: source is separated from unrelated shared-worktree changes; current runtime has not been replaced.
- Unverified: MR merge and actual Safari device behavior. Runtime/production remain unchanged.
- Discard: old embed MR is a separate change, not part of this delivery.
- Restore: branch `fix/opencraft-message-window-20261005`; scope is the files listed above.
- Next action: finish clean-source checks, commit/push, create MR and attempt normal merge.
