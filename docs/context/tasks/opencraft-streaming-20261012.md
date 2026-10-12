# OpenCraft streaming responsiveness

## goal
Bound visual streaming lag and reduce repeated projection/Markdown work without changing ordered conversation semantics.

## non_goals
- No backend restart, backend deployment or inference.
- User follow-up explicitly authorizes commit, push and merge into master for the streaming change.
- 2026-10-13 follow-up explicitly authorizes merging into the current preview by updating static frontend resources.
- Do not mix the separate Anthropic protocol work.

## requirement_ids / requirement_refs / requirement_excerpt
- User, 2026-10-12: implement frame batching/completion catch-up, bounded animation, stable Markdown prefix caching; “搞完了不要重启后台”.
- Reviewed model: /data/tmp/opencraft-stream-investigation-20261012/MODEL.md.

## interface_refs / data_structure_refs
- appserver-session/src/{view-store,resume-coordinator,projectors,projection-barrier}.ts: notification order and consecutive published view revisions.
- chat-document/src/{compiler,preprocess,streaming/session,streaming/identity}.ts: immutable parsing results and candidate CAS.
- chat-render-react/src/fade-timeline.ts: stable segment keys and bounded starts.

## history_context
- current_design_refs: opencraft/docs/chat-ui-architecture.md; docs/engineering/journeys/agent-request-streaming.md.
- relevant_evolution: 665cbe009 added the existing blank-line prefix cache and Chinese presentation. It does not provide safe container/reference boundaries.
- superseded_refs: fixed recovered ref/codex is comparison evidence only.

## acceptance
- Ordered bursts publish once per frame; completion/interaction/recovery flush preceding deltas without loss or duplicate append.
- Animation waiting stays bounded, including remount; completed documents fully visible.
- Streaming semantic AST matches the full parser on complete inputs across list/code/quote/reference cases.
- Measure actual component animation and long-document compilation in isolation; backend untouched.

## affected_paths
- opencraft/packages/appserver-session, workbench-runtime, chat-document, chat-render-react, chat-render-web.
- Relevant tests and mapped architecture documentation.

## required_context / context_receipt
- Read root and opencraft AGENTS, five routed context files, platform/chat architecture and maintenance skill + verification; maintain platform ports and session ownership.

## evidence
- Existing prefix probe and CPU/fade measurements: /data/tmp/opencraft-stream-investigation-20261012.
- Isolated checkout /data/opencraft-streaming-20261012, base 096f91e64.
- Final focused suite: 91 passed; final chat suite: 609 passed, including the nested-fence regression.
- Seven affected workspaces typechecked successfully, including Web and Expo; Web build passed (apps/workbench-web/dist).
- Actual browser smoke: 5000 segments, maximum animation delay 96ms, zero hidden spans at 500ms and after completion.
- Synthetic 50k-character multi-paragraph incremental compile mean 2.90ms, p95 14.07ms; prior measured mean 204.31ms included the old cache. These are workload-specific, not live session results.
- Broad appserver tests: 271/275 and SSH 32/32 passed; workbench unit tests: 338/344 passed. All ten failures reproduced on the clean 096f91e64 baseline in /data/opencraft-streaming-baseline-20261013.
- Baseline failures: four remote Codex reasoning-summary adapter fixtures and six source assertions for older modal/Native/permission/panel layouts. No unrelated fixes applied.
- Staged change-impact guard passed using an isolated temporary Git index; user's index untouched.

## risks
- Stale authority at reads/commands, reentrant flush, late callbacks after reconnect; use ordered flush barriers and generation/lifecycle guards.
- Cache boundaries, global references, preprocessing, abandoned renders; conservative fallback and equivalence tests.

## validation
- Focused session/document/render tests; affected workspace typechecks; boundaries and full gate; isolated real browser component checks.
- Change impact validation for changed files; no service restart.

## decisions
- Bound animation first; frame batching owns ordered projection batches, not a typing queue; grammar-safe cache with conservative fallback.

## scan_scope / scan_output
- Only affected packages, tests and exact reference files. No user messages or secrets read.

## handoff
- Implementation and scoped verification complete; existing Anthropic checkout untouched. No commit/push, backend restart, live asset replacement or deployment performed.
- Web artifact: opencraft/apps/workbench-web/dist. Running UI does not yet consume this artifact.
- Full gate was interrupted during sequential typechecks; affected typechecks and relevant test stages completed separately. The shared gate cannot be reported green because the ten baseline failures remain. Remaining unrelated gate stages were not claimed verified.

## checkpoint
### stage
2026-10-13: implementation complete, final evidence collected; no runtime rollout.

### verified
Ordered original notifications publish once per batch, preserving notification revisions and consecutive Replica entries. Completion/full snapshots, reads/interaction writes, suspended frames, old generations and disposal covered. Parser tests compare every incremental split across containers/references/extensions. Stable node identity and abandoned-candidate CAS covered. Browser visibility and scoped types/build passed.

### unverified
User's exact live Hermes/Codex session CPU/event trace, actual Expo device rendering and full shared-gate green status. Backend PIDs changed externally between user turns; this task only read service state and never invoked restart or replaced its assets.

### discard
Earlier claim that every compile always runs the full lexer was corrected in the investigation report. Blank lines and an apparent following block alone cannot prove a container stable.

### restore
Changes remain in /data/opencraft-streaming-20261012 on codex/opencraft-streaming-20261012. Evidence logs in /data/tmp/opencraft-stream-investigation-20261012; clean baseline checkout available for comparison.

### next_action
Review/deliver the verified source changes; live rollout and commit/push were outside this implementation scope.

## preview_rollout
- User follow-up: “合入当前预览”.
- Current backend PID 1073653, started 2026-10-13 00:16:13 CST; runtime remains untouched.
- Current UI build 20261013-ioa-participants-r2, built from the dirty message-sender preview checkout at 2e3958578 plus IOA/permissions/height/Markdown overlays.
- Independent merged source: /data/opencraft-streaming-preview-20261013, copied all source overlays and merged streaming changes with no conflicts. Preserve prior immutable assets and back up replaceable entries.
- Published frontend build 20261013-streaming-preview; preserved backend PID 1073653 and start time. Served entry and asset hashes match the rebuilt artifact; previous immutable assets retained and mutable entry backup recorded.
- Merged source: fresh local npm ci, Web typecheck/build passed, 93 focused tests passed, real browser animation smoke and synthetic-backend packaged participant UI passed. Additional pre-existing TencentOA controller suite stalled and was terminated; not reported green.
- Backup/evidence: /data/tmp/opencraft-streaming-preview-20261013/delivery.json and previous-web-entry. No commit/push/backend restart.

### preview_checkpoint
2026-10-13: authorized static frontend update complete. Current preview consumes the merged artifact. Earlier implementation handoff records the pre-rollout state. Actual live conversation performance remains unmeasured; no model turn submitted.

## git_delivery
- User follow-up: “提交 推送 合入master”.
- Deliver only the isolated streaming implementation, tests and design/context documentation; current preview overlays and separate Anthropic work remain outside this commit.
- Latest fetched master: a02f31d2c. Integrate it before final checks/push; preserve existing baseline test failures and normal server review gates.
- Root/OpenCraft instructions and Gongfeng skill read; HTTPS Git credential helper works, default SSH key is unavailable.

### git_delivery_validation
- Rebased onto a02f31d2c; only a design-document insertion conflicted, resolved by retaining both user-sender presentation and streaming sections.
- Final source checks: 95 focused tests, 609 Chat tests, all seven affected workspace typechecks, platform boundaries, Web build and real browser animation smoke passed. Dependencies installed locally from lockfile for delivery.
- Existing protected Gongfeng configuration reused through mcporter-internal; read-only current-user authentication succeeded. No credentials persisted or printed.
- Final scoped changes contain 24 files; no Anthropic/backend/preview-overlay source mixed into the commit.
- Remote delivery follows normal MR gates; no review/check bypass.
