---
id: opencraft-timeline-presentation-order-20261005
type: task
scope: Preserve same-conversation chronology with ordered presentation segments.
status: complete
authority: primary
reviewed_at: 2026-10-05
derived: false
---

## goal
Diagnose and repair older activity moving to the tail and live answers appearing in the middle after refresh, without creating additional execution owners.

## non_goals
- User subsequently authorized implementation, then commit/push/integration into master. No live requests that acquire session ownership, restarts, preview replacement or deployment.
- No secret/credential output or changes to unrelated dirty-worktree files.

## requirement_refs / requirement_excerpt
- Current user screenshot and clarification: older red-box commentary appeared last; streaming appeared in the middle; refresh retained it.
- Follow-up authorization: inspect Codex's model, then implement ("好的搞起来。"). No deployment authorization in this turn.
- Delivery authorization: "提交推送，盒入master". Integrate only this repair into remote master and preserve other uncommitted work.

## interface_refs / data_structure_refs
- `opencraft/packages/chat-core/src/agent-activity.ts`: `createAssistantTurnPresentationPlan`, `createTimelineTurnPresentationPlan`.
- `opencraft/packages/chat-core/src/builtin-projectors.ts`: assistant phase and async-question projection.
- `opencraft/packages/chat-core/src/turn-user-message-normalization.ts`: steering identity normalization.
- `opencraft/packages/appserver-session/src/merge-turns.ts`: ordered history reconciliation.
- Invariant: presentation may hide/collapse facts, but cannot relocate an earlier response segment past later user input and answers.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`, activity ownership and ordered-history sections; `opencraft/docs/platform-architecture.md`, renderer-neutral ownership.
- relevant_evolution: current live build `20261005-navigation-ownership-l5qv5Y`; renderer presentation collects before-activity, answer-content, and after-activity into fixed buckets.
- superseded_refs: none used.

## acceptance
- Identify actual conversation and recorded order without changing session state.
- Reproduce reordering using the current pure projector/presentation functions.
- Separately verify last-answer streaming and settled-history behavior.
- Preserve chronological slots across questions, replies, steering and auxiliary interactions; collapse cannot move messages across boundaries.
- Preserve source-keyed identity through phase/completion changes and history prepend; at most one live owner and one Turn timer.
- Verify shared Core, Web component and Native type boundary; leave current preview unchanged.

## affected_paths
- Shared model: `opencraft/packages/chat-core/src/{agent-activity,builtin-projectors,conversation-presentation,timeline,timeline-turns,work-status}.ts`.
- Web integration: `opencraft/apps/workbench-web/src/components/conversation.tsx`.
- Regression coverage: `opencraft/tests/chat-{core,ordered-presentation}.test.ts`, `opencraft/tests/fixtures/ordered-{response-items,presentation}.{ts,tsx}`, `opencraft/scripts/smoke-ordered-presentation.ts`.
- Contracts: `opencraft/AGENTS.md`, `opencraft/docs/chat-ui-architecture.md`, `opencraft/design/invariants.md`, `docs/engineering/journeys/agent-request-streaming.md`, this Task Pack.

## required_context
- Root/OpenCraft AGENTS; OpenCraft maintenance skill and verification reference.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Scope and evidence rules | Read-only diagnosis, preserve unrelated changes |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Ownership tracing | Trace raw facts through session/core/renderer |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Verification | Separate replay proof from phone visual acceptance |
| `opencraft/docs/chat-ui-architecture.md` | Presentation and chronology authority | Ordering must survive disclosure |
| `opencraft/docs/platform-architecture.md` | Core/Web/Native responsibility | Put one segmented planner in shared Core, not independent renderer regrouping |
| `.agents/context/change-impact.json` | Canonical documentation impact | Update `docs/engineering/journeys/agent-request-streaming.md` alongside source |
| Task/Checkpoint templates | Recovery contract | Structured diagnostic handoff |

## evidence
- Context route `opencraft timeline older assistant messages reordered after reconnect` returned no matches; fallback scans restricted to session/core/renderer and their tests.
- Implementation route `opencraft ordered timeline segments activity disclosure` also returned no match; used the same bounded owner/test/documentation scan.
- Read-only native state lookup identified thread `01a0ee74-86df-78c0-8453-80f07645188b`, named `用户问题【便共享】`.
- Raw rollout turn `01a10873-9fe7-7810-a5ce-707905c90dd0`: async question at 19:52:39 UTC, old red-box commentary at 19:53:32 UTC, first conclusion at 19:54:05 UTC, follow-ups and conclusions through 19:54:24 UTC. All belong to the same turn. The async question has phase `final_answer`.
- Temporary replay `/data/opencraft-timeline-diagnosis-61orlo/replay.ts` reads recorded item-completed facts, adapts native field casing, and uses inert command placeholders. It never contacts AppServer or emits private tool arguments.
- Raw/core projection selected order: question → command → user answer → old commentary → conclusion1 → follow-up1 → conclusion2 → follow-up2 → conclusion3.
- Before repair, presentation selected order: question → conclusion1 → conclusion2 → conclusion3 → command → user answer → old commentary → follow-up1 → follow-up2.
- Before repair, both settled and last-answer-streaming assertions proved the pure presentation moved old commentary after later answers. After repair, both replay assertions require presentation order to equal projected source order and pass.
- Live web asset `a-B0U_KuGm.js` contains the same fixed-bucket classifier. Web `conversation.tsx` renders its slots directly.

## risks
- Replay reconstructs native completed facts, not a captured browser DOM; it proves deterministic presentation reordering, not every concurrent history anomaly.
- Do not infer raw history corruption or fix by sorting opaque IDs/timestamps.
- Existing dirty-source ordering tests concern history windows, not this within-turn presentation loss.

## validation
- Pure recorded-fact replay now preserves source order for settled and streaming cases.
- Existing `chat-core.test.ts` and `conversation-history-order.test.ts`: 105/105 pass. Their passing baseline does not cover this within-turn async-question/multiple-answer chronology case.
- Bounded live-asset predicate check confirms classifier present, answer bucket emitted before post-activity, and displayable-content boundary used (all true).
- Existing focused tests are diagnostic baseline only, not evidence that ordering is correct.
- Post-repair `npm run test:chat`: 468/468 pass, including 10 ordered-presentation regressions and history/clock ownership coverage.
- `npx tsx scripts/smoke-ordered-presentation.ts`: four real Web component cases pass (desktop/touch-sized Chromium × light/dark). Collapse, append, prepend, completion and reload retain order; streaming answer DOM identity and current-response copy scope remain stable; one live owner. AppServer boundary is a synthetic fixture, not a live service.
- All workspace typechecks, platform boundaries, typography and i18n checks passed during `npm run gate`; standalone Web build passed.
- Full gate did not pass: unrelated `extension-artifacts.test.ts` failed deep equality because the restored record adds `artifactRef`. The failed worker retained resources for over three minutes and was stopped by its exact PID; no product service was stopped and no extension code changed. Later gate stages were not reached.
- Repository documentation validation, scoped docs-impact and `git diff --check` passed.

## decisions
- Root cause is within-turn presentation grouping, with async-question final phase triggering early boundary closure; multi-answer/steering in a single turn exposes the lossy fixed buckets.
- A fix must preserve chronological response segments while keeping a single execution/lifecycle owner; it must not equate one turn with one indivisible answer or globally move user frames first.
- Implementation and commit/push/master integration authorized by follow-up; deployment and restart remain outside scope.

## scan_scope
- Session ordered merge/history/resume; chat-core normalization/projection/activity; Web conversation renderer; exact target rollout.

## scan_output
- Only labeled-order output from temporary replay; no raw private-record export.

## handoff
- Implementation and relevant verification complete. Current preview still uses the old fixed-bucket planner; do not claim production/device repair until preview replacement and phone acceptance are requested and performed.

## stage
Implemented and verified; preview unchanged.

## verified
- Before repair, source chronological order survived core projection but not presentation planning.
- Live bundle contains the implicated planner; refresh reproduces it deterministically.
- Repaired shared planner preserves recorded order; the actual incident replay and synthetic real-renderer regression agree.

## unverified
- User-device DOM has not been directly inspected; no production repair is claimed.
- Native device behavior is not exercised; Native consumes the shared model and passes typecheck.
- Full gate is not green due to the unrelated extension-persistence failure documented above.

## discard
- Cross-conversation confusion and browser-cache-only explanations do not match recorded replay evidence.

## restore
- Replay path, exact thread/turn, and implicated functions listed above.

## next_action
If requested, replace preview using the verified front-end build and confirm the affected conversation on the user's phone. Do not restart or publish implicitly.

## Codex reference and proposed repair model

- Follow-up request: propose ownership model and inspect local Codex reference; still analysis-only.
- Context route `opencraft timeline presentation ordering Codex reference async question steering` has no match. Searches restricted to the original three relevant renderer modules and exact old-reference conversation/module neighbors.
- Read `/data/codex-new/codex-26.930.31428-12913/README.md`: original extracted application version 26.930.31428/build 12913; CLI metadata 0.160.0. This is static reference evidence, not proof of current hosted behavior or a launched reference-app replay.
- `split-items-into-render-groups-615e1ff2f44e.js`: eligible assistant-candidate predicate explicitly excludes `delivery === async` and `requestUserInputAsync`; selects one candidate from the ordered stream rather than collecting every answer into a global answer bucket. Post-assistant membership is re-filtered against original order when necessary.
- `generated-image-output-visibility-fc11a471360b.js`: sequential transcript grouping flushes current activity when encountering user or assistant messages; stable block keys use item/search/call identity and can reuse a previously surviving group anchor.
- `local-conversation-thread-turn-entries-a51c4d8c8b57.js`: detailed transcript splitting is a conditional path for `preserveServerUserMessages` (and Aeon-related presentation), not a universal claim about all Codex threads. Child render entries share the same execution turn, have identity-bearing transcript keys, and expose turn extras only on the last child.
- Relevant current `chat-core.test.ts` assertions preserve a single synthesized surface/Activity slot and unique Thinking; update the former contract only where semantic boundaries demand separate ordered groups. Unique execution and live-state ownership must remain.

### Ownership

| Owner | Authority | Excluded responsibility |
|---|---|---|
| Session/Replica | Native identity, ordered facts, read/reconnect reconciliation, lifecycle | Render grouping and disclosure preferences |
| chat-core presentation | One ordered slot stream, semantic boundaries, current-response cursor, final-answer eligibility | Additional persisted turns or timestamp sorting |
| View disclosure preferences | Collapse choice per stable activity segment | Moving messages across segment boundaries |
| Turn parent/live presentation | One execution lifecycle, at most one active Thinking owner, one total-duration/completion summary | One indivisible activity group for every item in the turn |
| Web/Native renderer | Render the shared ordered plan and keyed nodes | Independent user-first/answer-first regrouping |

### Proposed contract

- Derive ordered presentation slots, do not create artificial protocol turns. Retain source order across user input, async questions, answers and auxiliary interactions.
- Make answer eligibility a separate predicate from visible text and final phase; never rewrite authoritative phase merely to fix rendering.
- Activity grouping is contiguous only: user input, a visible response or an interaction ends the preceding segment. Collapse cannot span those boundaries or extract steering messages into another global bucket.
- Stable segment/row identity uses authoritative source identity and reconciled surviving anchors, never array indices, phase, completion state or generated timestamps. Streaming updates only their existing row.
- One active presentation owner is selected from the current response suffix, not all historical assistant messages. Historical final answers cannot suppress current work after new input; completed earlier segments cannot inherit current running state.
- Lifecycle, permissions, queue/steer, cancellation and total elapsed time stay turn-owned. Multiple display segments do not become separate executions or duplicate total duration/completion cards.
- Simple single-answer turns retain their existing appearance. Multi-response turns gain only the grouping needed to preserve chronology.

### Required regression sequence

- async question with final phase → user answer → commentary/tool activity → answer → steer1 → answer → steer2 → streaming answer.
- Assert visible uncollapsed facts retain source order, collapsing preserves message positions, exactly one active owner, distinct segment disclosure identities, and phase/completion updates retain row identity.
- Repeat using settled history, refresh/reconnect, delayed history, older-history prepend, and streaming continuation; run both shared-core and real-renderer tests.
- Avoid narrowing the fix to excluding async questions alone: that handles the first trigger but leaves multiple final answers/steering in a single turn vulnerable to fixed-bucket reorder.

### Implemented contract

- Sequentially flush contiguous activity at semantic content boundaries. Later user/interaction frames remain in the ordered shared assistant surface instead of separate global first/last buckets. Source protocol frames remain unchanged.
- Carry `delivery: async` through text projection; it cannot become a final-answer boundary or copy action merely because its native phase says final. Ordinary unphased answer text does not gain final-only collapse permission.
- Key each activity segment by its preceding source boundary; stream/phase/completion/prepend changes retain established response rows. Collapse preferences are segment-owned.
- Select current Thinking and answer-copy scope from the latest response suffix. Ended historical segments stay complete while the Turn continues; exactly one segment can receive the Turn clock/duration. Native consumes this same model.
- Timeline phase follows the latest chronological input/work/answer instead of any earlier final answer. Work clocks prefer the current real answer Item timestamp and reject stale Turn-level final timestamps after multiple answers or async questions.
- Web exposes source/slot identity for real-component regression and copies only the current response's marked blocks. No new AppServer protocol, persisted Turn, runtime lease, or inferred timestamp ordering was introduced.

### Isolated integration

- Route `opencraft timeline presentation commit push merge master` returned no matches; exact diff review and adjacent regression/build entry checks used instead.
- Base: remote master `e0c1f1b373d332519cf35c19a9ce2c547ad42677`. Delivery branch: `fix/opencraft-timeline-order-20261005`.
- Apply only this task's hunks in an independent worktree. Attachment normalization, optimistic client-message identity, scrolling/reflow, themes, older design edits and translations from the dirty development tree are excluded.
- Synthetic user fixture retains native client identity so existing Codex normalization recognizes real follow-ups; its display keys use authoritative Item identities and do not depend on the excluded optimistic-message-key change. Browser locators match those source identities.
- Original development tree and running preview remain unchanged. Remote delivery must use ordinary fast-forward push, not force; verify the resulting remote master hash in the user handoff.

### Isolated integration verification

- Replayed the actual recorded incident using the isolated source: settled and streaming presentation both equal projected source order.
- `npm run test:chat`: 456/456 pass, including the ten new ordered-presentation regressions. The earlier development-tree 468-test count includes unrelated uncommitted coverage and is not the delivered-tree count.
- `npx tsx scripts/smoke-ordered-presentation.ts`: four real-component cases pass (desktop/touch-sized Chromium × light/dark); collapse, stream, prepend, completion and reload preserve message order and identity with one live owner.
- `npm run build:web` passed; i18n (174 messages), its ten tests, platform boundaries and typography passed. Shared-package/plugin typechecks passed; Web and Expo typechecks separately passed after installing their existing app-local dependency directories.
- First isolated gate attempt failed because dependency reuse initially omitted Web/Expo app-local packages. Those dependencies were restored from the unchanged master integration environment and both affected typechecks passed; no source/lockfile workaround was added. The complete gate is not claimed green.
- Separate bounded replay of the unchanged `extension-artifacts.test.ts` reproduced the previously reported `artifactRef` equality failure. Its worker remains open after assertion failure, so the bounded run ends with timeout exit 124 after emitting the failure. No unrelated extension correction is included.
- Fixture isolation initially removed native client IDs and thereby triggered Codex's intentionally nonvisual follow-up normalization; restored the fixture's native IDs, while retaining master Item-based render keys. All ten regressions and browser cases then passed without importing the unrelated optimistic-key change.
