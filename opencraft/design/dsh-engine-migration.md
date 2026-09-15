# HyperNode DSH migration contract

## Migration status and evolution

The six-area migration is complete; see the
[final acceptance matrix](dsh-complete-migration/acceptance.md). Notes below
record intermediate states and are superseded where they describe pending
work. Platform boundaries in the acceptance matrix remain intentional.

Generation creation/resume must use the standard Agent factory and mount the
recorded Agent preset during setup, before publication. Merely loading a seed
does not restore the tool/Skill/policy composition. Restored built-in tools and
real read-only write rejection are now tested.

Pre-conversation Skill reads use a separate original FileSystemSkillProvider
scope; per-Agent reads retain native precedence. Explicit reload invalidates
through provider-owned public control, updating native and UI catalogs together.

Pending input now uses copied HyperNode ThreadQueueStore rather than relying
on the in-memory native inbox. Logical queue IDs persist independently from
native IDs. Restored rows are paused until an explicit start; authoritative
native consumption retires them and prevents duplicate recovery execution.

Native histories now use a rebuildable private event index. First scan must
cover the full source before reads; subsequent refreshes fetch the latest tail
until the recorded watermark. Immutable retired generations are served without
re-scanning. Index conflicts or regressed source watermarks are errors.

Custom effective sandbox/approval combinations are retained separately from
preset labels in generation intent and applied through canonical setters.
External-host policy reads require recorded native evidence; absence is an
explicit error, not a hardcoded workspace permission claim.

Capability output now preserves text and durable images through native
attachment admission and AppServer history hydration. No remote result URLs
are fetched; unsupported audio errors explicitly. Async attachment resolution
is ordered before dependent presentation events.

Queue consumption now uses reserved durable request identity before claiming a
new epoch. Deletion retires that authorization. Reconnect transfers active
control only from an explicitly disconnected owner with matching principal;
live windows cannot be displaced. Real queue/reconnect scenarios are verified;
whole-host queued-input restart still needs acceptance.

TextDeltaPacerController now smooths actual client notifications behind an
ordered presentation queue. Logical ledger updates remain immediate; Item and
Turn completion cannot overtake paced text. Interruption flushes, disposal
revokes callbacks. Execution telemetry records payload-free counters/timing
through runtime/diagnostics/read instead of no-op hooks.

Owned-engine permission projections read actual runtime services. Named profile
selection writes through permissionPresets and is carried into a new generation;
unknown policy is not silently widened. DSH file enforcement is not mislabeled
as Codex workspace enforcement. Custom knob and external-host cases remain open.

Pre-checkpoint native creation is now protected by a durable exact-seed intent.
An existing unpublished generation is resumed only after its persisted prefix
matches that intent; failure never overwrites the old checkpoint. Fault-injected
recovery is verified; true process-kill-window acceptance remains open.

The checkpoint-committed/routing-uncommitted crash window is reconciled from
durable matching evidence: prior logical coordinates in routing intent and
seed boundaries in the checkpoint. Incomplete evidence cannot publish a
native generation. Native creation before checkpoint commit still requires
orphan recovery rather than assuming success.

The owned-engine restart path now creates and routes a new checkpoint-derived
native generation. Logical Thread IDs remain stable; native seed is excluded
from presentation history, and new sequence/Turn coordinates extend the previous
generation. Pending native publication is hidden from events and listings.
Crash between separate checkpoint and routing commits still needs recovery.

Generation creation is serialized per logical session. Failed creations
dispose their runtime handle; successful identities publish only after native
flush and checkpoint commit. Committed generation maps reload at plugin startup.
Real-engine racing creation and restart readback are verified, but main-host
automatic routing is not yet connected.

Native surface checkpoints now flush the log before atomically recording the
surface and watermark, and refuse stale-generation writes. The engine plugin
can create a new native generation using copied HyperNode surfaceToSeed.
This is verified against real DSH; automatic logical-thread routing to those
generations is still pending and must not be inferred from control tests.

WebSocket hosts now expose a negotiated loopback HTTP transport for browser
proxy use. It rejects non-loopback targets and control-plane ports, strips
credentials, bounds payloads, and supports per-connection cancellation.
This is a separate page transport from capability tool execution.

Restored conversations negotiate host-capability registration after hydration.
Browser definitions need JSON Schema dialect adaptation: full schemas remain
validated before execution. A real-browser test currently opens a tab but fails
to load its loopback URL because the WebSocket host lacks the HTTP transport
seam. Browser integration is therefore still incomplete.

Capability instructions now register as a real per-Agent Skill with a private
materialized SKILL.md. A plugin-owned scope provides required tools/skills
services; unregistration disposes both. Scoped skills/list reads actual engine
definitions, reports non-file definitions explicitly, and never fabricates
paths. Pre-conversation discovery and forceReload still need completion.

Owned local-host startup now loads the capability plugin and connects it to
the owner/epoch-checked broker. Private patch credentials are temporary and
cleaned on shutdown. Plugin assets are included in desktop packaging. Real
synthetic tool requests use the production path; browser and Skill acceptance
are not implied by this result.

An isolated real-engine test now loads dsh-capability-plugin.mjs via a DSH
patch and validates scoped registration/invocation/return. The plugin consumes
validated raw JSON Schema, not defineTool's different authoring shorthand.
Production startup and browser/Skill attachment remain incomplete.

The host capability broker owns connection-scoped dynamicTools registrations
and directed request/result/cancel lifecycles. Engine registration and Skill
injection are still pending; do not advertise the bridge as end-to-end ready.

The active [complete migration plan](dsh-complete-migration/task_plan.md)
retains six additional boundaries beyond the previously validated event core.
Execution admission tables and journal are now source-imported with a private
SQLite port in dsh-execution-authority.ts. They remain staged implementation
until connection-aware RPC dispatch and native-start correlation are wired and
verified. Do not describe the full adapter as migrated on method-count evidence.

The follow-up [host acceptance matrix](dsh-host-acceptance.md) covers page
teardown, owned-process recovery, timeout, tools, approvals and real DSH scenarios.

## Source and ownership

Reference: ref/hypernode working-tree snapshot described in REFERENCE-SNAPSHOT.md.
The application imports the TurnManager implementation, tool projection, and
engine processSessionEvent / completion / interruption / failure / pacing-barrier
methods. TypeScript types and imports are removed mechanically for isolated
host factories; core method bodies are retained.

Local ports own process transport (one shared DSH web host rather than SSH
workers), credentials/models, timestamps from native events, deterministic
Item allocation and notification delivery. There is no deferred delta queue
in the local transport; afterDrained runs synchronously. Distinct Item creation
allocates distinct identities from native sequence plus allocation ordinal,
and replay of the same native log reproduces the identities.

## Invariants

Turn and Item history pages now use the copied HyperNode
transparent-thread-history projection. Native event pages are assembled before
folding to avoid fabricating full Turns from partial event windows. The current
read-through cost is not a substitute for the required checkpoint/index work.

Execution-native RPC identity maps durably to the original client message ID,
scoped by thread; replay must preserve optimistic submission reconciliation.
The source HyperNode command classifier now replaces the local heuristic and
is exercised by its original corpus. It is never an execution permission check.

- Exactly one ordered Item ledger per Turn; active reasoning and text are
  readable during execution, not just after completion.
- Explicit native completion is required for success. Stopped histories without
  terminal evidence fail as unconfirmed rather than fabricate completion.
- Lifecycle summaries do not replace Item membership; historical full snapshots
  may replace membership.
- Interruption closes Items and clears local execution authority before the
  engine cancellation round trip. Late terminal events cannot reactivate it.
- Completion preserves original start time and computes elapsed duration.
- Reconnected event streams buffer new events while native history rebuilds
  active records; replay duplicates are rejected by native event sequence.
- Approval tool references resolve against the active imported tool ledger.

## Host adaptations and reference limitations

- Models remain in product-owned models.json and credentials stay host-side;
  HyperNode gateway/SSH materialized-user policy is not transplanted.
- Local DSH questions/approval use its HTTP response service; these operations
  must not be removed merely because the reference worker exposes a different
  transport.
- Tool errors follow the reference structured isError and exit-code contract.
  Unlike the retired local heuristic, a textual timeout marker alone is not
  treated as a structured failure.
- HyperNode plan notifications are preserved, with a deterministic historical
  todo-list projection for OpenCraft history consumption.

## Verification

test:dsh-bridge includes source lifecycle regression and migration regressions.
smoke-reasoning-contract executes a real DSH against a local synthetic model
and verifies user/assistant frames survive completion without real credentials.
