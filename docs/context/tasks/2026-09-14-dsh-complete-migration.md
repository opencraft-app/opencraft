---
id: dsh-complete-migration
type: task
scope: Complete the six remaining DSH migration boundaries
triggers: [opencraft, dsh-complete-migration]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/design/dsh-engine-migration.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## Full objective

Implement execution admission/ownership (bindTurn, epochs, write leases, late
native-start fencing); host capability registration/request/result/cancel and
Skill injection; checkpoint/surface-generation/surfaceToSeed recovery;
thread/history/Item pagination/queue/skills translation; effective permission
declarations; command classification, asynchronous pacing and telemetry.
All six remain required. No smaller subset constitutes completion.

## Context and boundaries

Current source and imported HyperNode execution/write-lease services inspected.
Route “opencraft execution ownership” returned no pack, followed by bounded
exact searches. Prior review is evidence of missing areas, not implementation.
Keep product model/credential ownership. No user-data changes, remote writes,
paid model requests or commits.

## Checkpoint

Final audit completed: all six requirements have concrete implementation and
verification in opencraft/design/dsh-complete-migration/acceptance.md. Full gate,
84-method parity, real runtime/queue/restart, real checkpoint-window SIGKILL,
UI permissions/browser/refresh, build/package/signature and native startup pass.
Later checkpoints below are historical and superseded by this completion audit.
No commit, push, release or user-data mutation.

Latest: UI permission selection reaches native logs and real read-only policy
denies a tool write. That test exposed missing Agent preset composition on
generation restore; fixed through standard factory setup before publication.
Overlapping edit lease release also fixed and tested. Final all-code gate and
packaged verification still required before any completion claim.

Latest: pre-conversation project Skill discovery and forceReload now use the
original filesystem Provider and its public invalidation control. Actual UI
metadata and native model catalogs agree in real DSH tests. Explicit pinned Ajv
runtime dependency added. Remaining final multi-client/UI/source audit retained.

Latest: HyperNode durable queue store is now connected. Real whole-Host restart
preserves queued input and logical ID, pauses recovery, starts explicitly through
admission and removes after dispatch. Native consumed-history reconciliation
prevents replays of known-consumed input. Focused regressions/typecheck pass.
Full final audit and remaining Skill/UI/dependency boundaries stay open.

Latest: native event history index connected and verified for bounded reads,
tail refresh, reopen, immutable conflict and regression rejection. Real DSH
host acceptance passes. Previous full gate passed; new all-DSH test discovery
is running and final whole-goal audit still required.

Latest: custom permission combinations survive new/orphan generation recovery;
external DSH no longer fabricates fixed policy when evidence is absent.
Same-owner capability updates compare actual specs and reject active changes.
Cross-package Headers iteration fixed. Focused tests pass; whole gate rerunning.

Latest: rich capability text/image results survive actual model continuation
and AppServer tool-history projection. Attachments use native validation and
durable references, not direct URL fetching. Failure/audio/unknown output is
explicit. Ordered stream hydration prevents terminal events overtaking image
admission. Full goal remains incomplete.

Latest: persistent queued request reservations are matched on native consumption;
new execution epoch is not granted to arbitrary queued events. Same-principal
disconnected-owner reclaim is connected to resume. Real DSH queue consumption
and actual socket reconnect/control tests pass. Whole-host queued-input restart
and contention edge audit remain incomplete.

Latest: asynchronous presentation pacing and execution telemetry are connected.
178 DSH regression tests and real-engine host acceptance pass; typecheck passes.
Pacing cannot publish completion before text drain, and telemetry excludes
content. Whole-goal acceptance, ownership/queue/custom permissions and other
remaining boundaries stay open.

Latest: owned-engine effective permissions/profile catalog and named-profile
setter connected. Real runtime knob changes and host recovery smoke pass.
Generation creation preserves its named preset. Unmatched custom policy,
external-host metadata, UI selection and other goal areas remain incomplete.

Latest: pre-checkpoint orphan recovery transaction implemented with durable
exact-seed intent and content comparison before resume. Fault-injection tests
prove single creation and later resume; mismatches refuse adoption. Existing
real-engine generation/race/restart test passes. Need true process-kill-window
acceptance plus remaining scope, not a broad completion claim.

Latest: durable pending route intent plus checkpoint seed coordinates recover
the checkpoint-committed/routing-uncommitted crash window. Tests recreate a
process boundary and verify idempotent publication and refusal of incomplete
evidence; real-engine restart/crash smoke and typecheck pass. Pre-checkpoint
orphan creation and remaining identity/performance issues remain incomplete.

Latest: automatic logical/native routing connected to owned-engine restart.
Real DSH restart/crash/continue and capability scenarios pass, original Item
IDs stay stable and .gN seed does not leak as new UI history or Threads.
Staged generation suppression persists in SQLite. Checkpoint/routing commit-gap
reconciliation and exhaustive identity/offset audit remain open.

Latest: serialized generation transitions and restart-loaded generation map
verified with real DSH (.g1, competing .g2 creation, process restart and .g2
tool-history readback). Publication occurs after flush/checkpoint commit.
Automatic main-host logical/native request/event/history routing remains open.

Latest: checkpoint projection/store and engine generation controls implemented.
Real DSH accepted a .g1 seed with tools and replies. Five source/store tests
pass; failure atomicity and stale-generation fencing verified. Main host's
automatic generation routing, concurrency and full restart workflow remain
incomplete. No broad completion claim.

Latest: loopback HTTP page transport added and rejection/header/redirect tests
pass, host and runtime typechecks pass. Original real-browser acceptance
currently rerunning; all other incomplete objective areas are retained.

Browser rerun completed successfully: actual DSH→broker→Workbench browser,
local page heading visible, tab list result returned, subsequent sends/reload
pass. The original page-transport failure is resolved; this does not complete
checkpoint recovery, ownership/queue, permissions, pacing or telemetry.

Current browser test fails at real iframe loading: Host Proxy reports that the
WebSocket host lacks loopback HTTP. Tool invocation/result and tab creation are
confirmed; do not mark browser capability complete. Resumed-thread registration
and JSON-Schema dialect translation were added; full constraints remain enforced
by Ajv, but negative cases and dependency closure still need verification.

Latest: capability Skill injection is active in real DSH with actual private
SKILL.md paths, scoped registration and revocation verified. AppServer
skills/list is connected to engine definitions for the opened conversation;
pre-conversation discovery and forceReload remain open. Browser real-action
verification and the other full-goal boundaries remain incomplete.

Production plugin bootstrap and CapabilityLink connect actual DSH execution
to owning WebSocket handlers. Real synthetic host capability scenario passes.
Restart re-registration and owner-only disconnect cleanup added; final
re-invocation after process restart is under verification. Skill injection,
actual browser execution and rich output handling remain incomplete.

Latest: real DSH Loader plugin registers agent-scoped capability ToolDefinitions.
The isolated synthetic model requests that tool, receives a host result, and
continues its next model call. Token rejection verified. Production startup/
broker/browser and Skill wiring still pending; no end-to-end browser claim.

Capability host broker added and connected to WebSocket registration/results.
Engine tool injection and Skill materialization remain pending. Scope remains
all six objectives; broker tests are not proof of actual browser execution.

Latest: source Turn/Item history paging connected, empty Item stub removed,
full native pages assembled before projection. 165 DSH tests and real-engine
synthetic smoke pass, host typecheck passes. Read-through full-history cost
will be addressed with required checkpoint/index migration. Skills metadata
needs path/scope from capability manifests and remains incomplete.

Imported unchanged ThreadExecutionTable, ThreadExecutionJournal and
ThreadWriteLeaseTable. Added SQLite storage port with private file permissions,
durable epoch reload and previous-boot fencing. Two focused tests pass for
cross-connection rejection, stale epoch/native-start/finish rejection and
restart recovery. Normal turn/start, steer and interrupt now receive exact
WebSocket owner identity. Native-start prefixes wait for the admission token
on user/message before publishing. Ten focused tests, host typecheck and the
real Workbench→DSH synthetic smoke pass. Remaining within ownership: queue
admission, disconnected-owner reacquisition, history client-ID persistence,
and bypass audit. All other objective areas remain pending. No preview build
or full migration completion is claimed for this intermediate checkpoint.

Next checkpoint: input identity mapping is durable and restored by thread;
queue mutation lease checks are connected (automatic queue execution still
pending). Full source command classifier and its 130 tests replace the former
local heuristic. Pacing/telemetry and requirements 2–5 remain incomplete.
