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
- User subsequently authorized implementation, commit/push/master integration, then front-end overlay replacement. No live requests that acquire session ownership, backend restarts or GitOps deployment.
- No secret/credential output or changes to unrelated dirty-worktree files.

## requirement_refs / requirement_excerpt
- Current user screenshot and clarification: older red-box commentary appeared last; streaming appeared in the middle; refresh retained it.
- Follow-up authorization: inspect Codex's model, then implement ("好的搞起来。"). No deployment authorization in this turn.

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
- Implementation authorized by follow-up; deployment, restart, commit and push remain outside this turn.

## scan_scope
- Session ordered merge/history/resume; chat-core normalization/projection/activity; Web conversation renderer; exact target rollout.

## scan_output
- Only labeled-order output from temporary replay; no raw private-record export.

## handoff
- Implementation, Git delivery and authorized Web-only overlay complete. Current preview serves the reconciled ordered-presentation build; actual phone incident acceptance remains for the user. Do not claim a backend restart or physical-device validation.

## stage
Implemented and delivered to master; authorized front-end overlay published and independently verified, backend unchanged.

## verified
- Source chronological order survives core projection but not presentation planning.
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
Ask the user to refresh and confirm the affected conversation keeps recorded order and streams at the tail. No additional restart, GitOps publication or account/session mutation is authorized.

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

### Git delivery receipt

- Follow-up user authorization: commit, push and integrate into master; no preview replacement or service restart.
- Isolated worktree `/data/mono2-timeline-integration-hs87vU`, branch `fix/opencraft-timeline-order-20261005`, based on remote master `e0c1f1b373d332519cf35c19a9ce2c547ad42677`.
- Only this task's 17 files/hunks were included; excluded dirty-tree attachment, optimistic-message-key, scrolling, theme and translation changes. Synthetic fixtures retain native client identity and use master's Item-based render keys.
- Isolated source passes actual-incident settled/streaming replay, 456/456 chat tests, four real-component browser cases, ten activity/user-layout neighbor tests, Web/Expo typechecks, Web build, i18n/typography/platform-boundary checks and staged documentation impact/link checks. Full gate remains non-green; unchanged extension-artifact persistence assertion reproduced separately with a bounded worker.
- Commit `efc37fe08bbce0ce5ec60f0fe741b377f90e35af` (`fix(opencraft): preserve ordered response segments within turns`) pushed to the feature branch, then ordinary fast-forward push to master.
- `git ls-remote origin` verified both branch and master at exactly that commit. Isolated worktree is clean. Original development worktree and running preview remain in place; only this local Task Pack receives the delivery receipt.

### Preview overlay authorization and preparation

- Latest user request: "叠加更新替换". Preserve existing preview features and backend; replace only Web static resources with rollback.
- Route `opencraft self hosted preview overlay timeline update replace` found no match. Read self-hosted-preview Skill, maintenance verification, headless/Web build contract, publisher and static-server/cache neighbor; do not synchronously stop this agent's own service tree.
- Actual owner changed since earlier diagnosis: PID 1048792, `opencraft-ssh-connect-menu-20261005-preview.service`, cwd/root `/data/opencraft-ssh-connect-menu-FESsEj/opencraft-server`, build `20261005-ssh-connect-menu`. Runtime SHA256 `96b6fc0042b4d348fe42e298253185d5703e4021e84c94c25923d75dc1f00347`; private data root retained. Health `ok` and `appServerConfigured` true.
- Active manifest already references chunks containing ordered-segment, source-slot and current-copy signatures; do not claim those signatures first appear in this overlay. Candidate will reconcile the latest reviewed source and metadata while retaining current SSH/navigation/theme development changes rather than replacing them with clean master.
- Candidate `/data/opencraft-timeline-overlay-VOAeGc`, expected build `20261005-timeline-overlay-VOAeGc`; old Web backed up before atomic entry publishing. No account/cookie/database copied; no model inference or session acquisition for verification.

### Preview overlay publication receipt

- Corrected two verification setup errors before publication: headless Vite invocation initially omitted its required serialized Host profile; crypto tests initially used plain Node rather than the TSX loader. The production guard was retained and the packaging source's exact profile was supplied; no source workaround was introduced.
- Current source Web build passed with headless Host enabled, HyperNode disabled and standard minification. Ten ordered-presentation tests, twelve Web release/cache/crypto tests and four actual-renderer cases (desktop/touch, light/dark) passed. Candidate built-app settings reload → Chat → Back/Forward passed in desktop and touch contexts with zero page errors.
- Compared active manifests: the ordered Core chunk `assets/a-Dc6SVg5j.js` is identical across old and new releases, confirming current SSH preview already included the shared planner fix. New release reconciles the current reviewed renderer/source and entry metadata rather than claiming the planner first shipped here.
- Atomic publisher switched `20261005-ssh-connect-menu` to `20261005-timeline-overlay-VOAeGc`: 32 new hashed assets, 445 reused assets, seven public files. Verified 456 manifest assets over the actual localhost HTTP origin against candidate SHA256; immutable asset caching and no-store index/version confirmed. Prior index entry remains available; no old resources removed.
- Replacement's actual built app independently passed settings reload → Chat → Back/Forward in desktop and touch browser contexts, zero page errors. WebSockets, inference and mutating requests were blocked during browser checks; no live Host or thread acquired. This is Chromium touch emulation, not physical iPhone acceptance or external HTTPS verification.
- Actual owner remains PID 1048792 / `opencraft-ssh-connect-menu-20261005-preview.service`, active with NRestarts=0; runtime SHA256 unchanged at `96b6fc0042b4d348fe42e298253185d5703e4021e84c94c25923d75dc1f00347`; health `ok` and `appServerConfigured` true. Private data root retained, no backend restart or runtime replacement.
- Generated evidence `/data/opencraft-timeline-overlay-VOAeGc/publication.json`; rollback Web `/data/opencraft-timeline-overlay-VOAeGc/previous-web`. Candidate uses the previously authorized dirty preview source at HEAD `5b3a3ccaf873692cc5d1649019a6a432c02f8769`, not a falsely clean master revision. SSH/menu, navigation and theme preview dependencies remain; no new commit/push or public mirror action.
- Full repository gate remains non-green for the already documented unrelated extension-artifact assertion. Phone verification of the original incident remains unverified.

### Repeat Git delivery confirmation after overlay

- User again requested commit/push/master integration after Web publication. Route `opencraft timeline overlay commit push integrate master` found no match; inspected root/OpenCraft instructions, original dirty worktree and isolated timeline delivery tree. Remote `ls-remote` freshly confirms both master and `fix/opencraft-timeline-order-20261005` are exactly `efc37fe08bbce0ce5ec60f0fe741b377f90e35af`.
- Isolated delivery tree has no staged or unstaged diff. Overlay introduced generated Web artifacts and a local evidence receipt, not another timeline source change. No empty/duplicate commit or unrelated dirty-source push was made; this repeat authorization is already satisfied by the verified prior delivery. Current preview remains unchanged.
