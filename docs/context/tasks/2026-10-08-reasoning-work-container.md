---
id: reasoning-work-container
type: task
scope: Nest returned thinking inside the response work disclosure without mixing tool and thinking controls.
triggers: ["reasoning work container", "思考过程用时外面", "nested thinking disclosure"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/docs/chat-ui-architecture.md", "opencraft/design/invariants.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
The response work disclosure owns both actual returned thinking and tools; their inner controls remain independent. A completed reasoning-only response must fold under its real Worked-for label, with the final answer outside.

## non_goals
No Host summary policy, engine transport, raw reasoning recovery, Markdown rendering redesign, desktop changes, public mirror, production or GitOps changes. Later explicit user requests authorize mono2 commit/push/master integration and then preview replacement.

## requirement_ids / requirement_refs / requirement_excerpt
External ID unknown. User reported thinking appearing outside Worked for, then explicitly requested “修改吧”, followed by “提交推送合入master” and “搞完再替换预览 要的。”

## interface_refs / data_structure_refs
AgentActivityContentUnit, createAssistantTurnPresentationPlan, createTimelineTurnPresentationPlan, resolveAgentActivityLayout; Web and Native work/inner reasoning renderers and stable View choices.

## history_context
current_design_refs: Returned thinking content in ChatUI architecture.
relevant_evolution: [summary delivery](2026-10-08-reasoning-summary-delivery.md), [fold ownership](2026-10-08-reasoning-fold-ownership.md).
superseded_refs: The previous sibling-slot contract incorrectly equates independent inner controls with independent outer work surfaces; its reasoning-only fixture reproduced the user's screenshot.

## required_context / context_receipt
Read root/OpenCraft AGENTS, maintenance skill and verification list, task/checkpoint templates, ChatUI returned-thinking section, platform package ownership, adjacent core/native fixtures and frontend-runtime-openspec-i18n card. Router queries for reasoning-only/work-container matched no pack; bounded exact source/test searches located the shared model and both renderer consumers. No provider calls, private transcript reads or account inspection.

For the later delivery request, read self-hosted-preview skill, the Headless Build Matrix contract, existing Web publisher, static serving and release validation code. Change-impact check routes the shared presentation contract to Agent Request Streaming; read that full journey and updated its existing OpenCraft presentation section without changing gateway/runtime protocol.

## decisions
Keep the original contiguous response work owner. Readable reasoning is a chronological inner content unit, splitting adjacent tool groups only; empty reasoning is an observation and creates no boundary or toggle. Final-answer eligibility, Turn clock and response/input boundaries retain their existing authority. Stable Item-keyed inner choices must survive outer collapse/remount and completion.

## acceptance / validation
Shared model tests for reasoning-only, tools/reasoning interleave, empty-to-readable, separate responses and interaction boundaries; Core/Web/Expo types and boundaries; actual Conversation mouse/touch and light/dark smoke plus Native component tests. No empty toggles or duplicate clocks/Thinking; first outer click reveals work, inner reasoning remains initially folded and independent.

## affected_paths / scan_scope
Shared activity model, Web/Expo renderers, adjacent tests and reasoning smoke, ChatUI/invariants docs only.

## evidence / verified
Before modification, the completed reasoning-only test passes with sibling reasoning plus a worked-for-only Activity and showToggle=false, exactly the undesired relationship. Existing published source commit is fc18e8386; this working tree starts clean.

- Shared Chat suite: 591/591 passed; focused shared/native suite: 138/138 passed. Native response-work test covers reasoning-only and reasoning-plus-tools, completion and outer remount with independent retained choices. Web phase/Native tests: 8/8 passed.
- Core, Web and Expo type checks, all workspace types, platform/typography boundaries, i18n checks/tests (10), cloud-desktop (142), Electron launch (4) and Web build passed. Full gate exposed an adjacent Hermes fixture still expecting the old sibling slot; updated it to assert nested thinking plus an outside answer and unchanged copy semantics. Re-ran extension suites (16 + 244 + 76) and connectors (32), all passed.
- Real Conversation browser smoke passed 12 engine/theme/input combinations (Codex/Hermes/DSH × light/dark × mouse/touch), including 24 long-empty/clock variants and 12 reasoning-only variants. It checks one work fold, real clock, final answer outside, first activation, independent controls, restored choices, streaming and history identity. Synthetic provider content only; no paid provider or iPhone OS claim.
- Desktop and touch reasoning-only browser screenshots visually reviewed. Full logs/screenshots are isolated validation artifacts outside Git, not application state.
- Continued gate reached the known unrelated `ssh-native-surface.test.ts:71` expected-value mismatch (`pin: false` omitted): 75 passed / 1 failed / 1 skipped. No claim that the complete gate passed; its later stages were not reached. Latest full Chat suite after all test edits: 591/591 passed.
- Source commit `9940589e0f2544ec80c3991419d75796c8f96b78` atomically fast-forwarded both feature branch and mono2 master; remote readback matched both refs. No force push or public mirror.
- Correctly flagged headless Web release `20261008-reasoning-work-container-9940589e0` built from that source; isolated static candidate mounted in real Chromium with zero page errors and 460 manifest assets verified by HTTP byte hashes. Web release tests: 10/10 passed. Its intentionally absent Host is not provider execution acceptance.
- Independent supervisor published only Web resources at 2026-10-08 12:23:39 UTC, preserving the original backend process, runtime SHA and data owner. Post-switch readback confirmed live build ID, source revision, listener/unit owner, health `{ok:true, appServerConfigured:true}` and all 460 asset byte hashes. Added 48 hashed assets, reused 434 and retained old assets/rollback Web entry. Runtime hash identity was checked before/after and is retained in private delivery evidence; no backend restart. Package manifest is the original runtime-package inventory, not an inventory of the subsequently published Web overlay.
- Staged change-impact and first-party documentation checks passed (zero broken links). Global Context catalog validation still reports historical task-schema and credential-heuristic findings outside this change; it is not claimed green. Generated catalog drift was restored rather than included in the delivery.

## risks / unverified
No actual iPhone OS acceptance. Full gate's unrelated SSH fixture failure remains. Existing browser documents keep their already loaded scripts until refresh; production/GitOps and public mirror were not changed.

## stage / handoff
Implementation, targeted browser/component validation, headless Web build, mono2 master integration and Web-only preview publication complete. Existing Host runtime, account/data owner and old assets/rollback entry preserved. Refresh the current page to consume the new bundle; no backend restart was performed.

## checkpoint

### stage
Source fix, Git integration and independent Web-only preview publication complete; receipt-only documentation commit remains.

### verified
Contiguous response work owns all returned reasoning and tools. Reasoning-only completed work folds under its real clock. Final answers and real response/input boundaries stay outside; no fabricated clock or duplicate Thinking. View-owned independent choices survive outer remount on Web and Native. Documentation replaces the previous sibling-slot contract. Remote refs and actual preview HTTP build/assets/health independently verified after publication; backend owner unchanged.

### unverified
Unrelated SSH fixture prevents a green full gate; iPhone OS untested. Current live preview is verified new Web / original Host, not a newly built full server package.

### discard
Previous sibling-slot / nearest reasoning-separated work-slice contract is superseded. Do not reuse the old delivery's validation JSON as evidence for this fix.

### restore
Canonical source branch `fix/opencraft-reasoning-work-container-20261008`, source commit 9940589e0 on mono2 master. The unrelated original desktop worktree was not modified. Preview publisher used durable assets-before-entry switching, retained old hashed assets and rollback entry; private scripts, screenshots, logs and package paths remain outside Git. Do not rerun that one-shot publication script: its old-build CAS intentionally rejects an already upgraded baseline.

### next_action
Commit/push this receipt-only update through ordinary fast-forward refs, then hand off the new preview and refresh instruction. No further runtime or code changes required for this request.
