## goal
Allow a user to delete a failed local queued follow-up from the OpenCraft composer.

## non_goals
- Change model availability checks, resend failed input, or delete a Host queue entry without its Server ID.
- Merge or release.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and follow-up in this chat: red failed queued messages cannot be deleted.

## interface_refs / data_structure_refs
- `ReplicaConversationRuntime.queuedSubmissions`: failed optimistic entries have a command ID and no Server queue ID.
- `ReplicaConversationRuntime.deleteQueuedSubmission`: route failed local IDs to local removal, Server queue IDs to Host deletion.
- `ComposerQueueTrayItem.dismissible`: deletion availability for the failed local entry; Send/Edit remain unavailable.

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: the runtime already had `dismissFailedSubmission`, but the composer disabled deletion without a Server queue ID.
- `superseded_refs`: none.

## acceptance
- A failed local queued message has an enabled Delete button, and deleting it removes that row.
- Local deletion sends no Host queue delete request; ordinary accepted entries still use the existing Host delete path.
- Submitting entries remain non-deletable; no implicit retry or model change.

## affected_paths
- `opencraft/packages/chat-runtime/src/replica-conversation-runtime.ts`
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `opencraft/packages/codex-composer/src/queue-tray.tsx`
- `opencraft/apps/workbench-web/src/app.tsx`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | Runtime boundary | Keep local failure separate from Host queue |
| `docs/context/domains/site-environment-routing.md` | Embedded site boundary | Do not infer deployment from local renderer |
| `docs/context/project/upstream-subtrees.md` | OpenCraft source ownership | Edit mono2 only |
| `docs/context/project/services/opencraft.md` | Service checks | Select affected workspace checks |
| `opencraft/AGENTS.md` | Local rules | Require behavior and client verification |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | State ownership | Keep Conversation as queue owner |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Verification | Check runtime and component behavior |
| `opencraft/docs/platform-architecture.md` | Thread lease boundary | Do not expand Host contract |
| `opencraft/docs/chat-ui-architecture.md` | Queue design | Preserve accepted and unconfirmed queue behavior |
| `opencraft/design/invariants.md` | Client interaction contract | Record local failure deletion boundary |
| `docs/engineering/domains/agent-gateway-runtime.md` | Formal design | Record local versus Server deletion |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Available site adjacency card | Checked adjacent queue test; no frontend/i18n path changed |

## evidence
- The screenshot shows failed rows with disabled Delete buttons.
- Exact search found `dismissFailedSubmission` in Conversation Runtime and disabled Delete in `queue-tray.tsx`; no prior UI caller.
- Focused queue/runtime tests: 48 passed; full chat suite: 596 passed. Affected chat-runtime, codex-composer, and Web typechecks plus platform boundaries passed.
- Real Chromium queue component probe: failed Delete was enabled and removed its row; submitting Delete stayed disabled and the accepted row remained.
- Web production build and documentation validation passed.
- Staged change-impact check and staged diff whitespace check passed.
- Full `npm run gate` reached `test:extensions` and hit an assertion in `tests/extension-artifacts.test.ts:38` (`artifactRef` present in actual persisted record, absent in expected). The extension suite then stalled; the gate was stopped. No extension code was changed in this task.

## risks
- A stale or incorrectly classified row must not route a command ID to Host deletion; eligibility derives from the runtime state.

## validation
- Focused runtime and composer queue tests; relevant typechecks, boundaries, Web build, and client rendering.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` before handoff.

## decisions
- Keep the existing Delete action; distinguish locally failed entries in the presenter and remove them in Conversation Runtime.

## scan_scope
- `opencraft/packages/chat-runtime/src/replica-conversation-runtime.ts`
- `opencraft/packages/codex-composer/src/`
- `opencraft/apps/workbench-web/src/app.tsx`
- Adjacent `opencraft/tests/chat-runtime.test.ts` and `chat-composer-queue.test.tsx`.

## scan_output
- The initial free-text route did not match; the exact OpenCraft path route returned the four required context files. Bounded `rg` located the existing local dismiss method and disabled control.

## handoff
- Source and Web build verified; current authenticated LightVela session and deployed client were not changed or tested. Full gate did not pass due to the extension-artifacts failure/stall. Commit, push, and MR submission were subsequently authorized; the MR records delivery status.
