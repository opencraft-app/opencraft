# Progress

FINAL: all six requirements audited against current code and executed tests.
See acceptance.md. Full gate, real DSH scenario replay after stable dependency
installation, true checkpoint-window SIGKILL, actual UI permission/browser
inspection, and final native build/package/signature/startup pass. Historical
pending notes below are superseded; no commits or user-data changes.

Final audit found and fixed premature lease release under overlapping same-owner
edits. UI permission selection now verified against actual native preset events,
not display labels; browser/reload passes. Real read-only tool test exposed
that generated Agents bypassed preset composition and thus had no built-in
tools. Generation creation/resume now use standard ctx.agents factories with
prepublication agentPresets.mount and persisted preset identity. Real restored
Agent tool invocation and denied read-only write pass. Prior full gate passed
before these final changes; rerun and packaged acceptance still required.

Skill discovery now mounts the original DSH FileSystemSkillProvider in an
isolated discovery scope for pre-conversation cwd reads. forceReload uses its
public provider-owned invalidate capability, so both UI and native model skill
catalogs refresh consistently. Real DSH tests discover a newly written project
Skill with correct path/scope before a conversation and inside an existing Agent.
Initial fresh-scope-only approach refreshed the UI but left model cache stale;
replaced it with actual provider invalidation, removing the synthetic read scope.
Ajv is now an explicit pinned runtime dependency (offline lockfile update).

Whole-Host restart exposed that DSH's pending inbox was not durable. Imported
HyperNode ThreadQueueStore source class/helpers and backed it with the execution
SQLite storage port. Queue input now persists before dispatch; stable logical
queue IDs map separately to native inbox IDs. Restarted pending rows pause until
explicit start through normal admission. Native input history reconciles consumed
rows so unknown outcomes are not blindly replayed. Accepted steer/start and
deletion retire durable rows. Initial steer regression resurrected a row and
was fixed at the acknowledged dispatch boundary. Real whole-Host restart,
stable ID, explicit start and removal tests pass; 13 focused tests/typecheck pass.

Rebuildable private SQLite native-event index now scans once and refreshes new
tail only; retired generations serve bounded pages without network re-scan.
Conflicting immutable events, regressed watermarks and incomplete initial
scans fail explicitly. Focused index/page tests and real DSH restart/tool/image/
queue/reconnect smoke pass; host typecheck passes. Prior full gate finished
successfully. Default DSH test command now includes all dsh-*.test.ts/mjs plus
host and loopback tests so new acceptance tests cannot silently be omitted.

Custom sandbox/approval knob combinations are now preserved exactly in durable
generation intent and re-applied on both new and orphan-resumed Agents. Actual
DSH read-only+never recovery passes. External DSH fallback folds real recorded
permission events and fails if evidence is missing instead of fabricating
workspace-write. Capability registration now compares specs and refuses changes
during active execution rather than treating all same-owner calls as no-ops.
Full gate found Headers iteration portability issue (fixed with forEach) and
fixtures lacking policy evidence (updated to represent actual initialization
events). Latest focused tests pass; fresh whole gate running.

Host capability results no longer collapse to text. Typed text/image output is
admitted through DSH's durable attachment service; order is preserved, failed
results and unsupported formats are explicit errors, remote image URLs are not
fetched. Native attachment references are hydrated through session.attachment
for AppServer live/history presentation, with ordered async stream delivery.
Rich-result unit tests, real model image-return/context and AppServer history
assertions pass; host typecheck passes. Audio remains explicitly unsupported
by the current DSH content model rather than silently discarded.

Queued inputs now reserve persistent native request identities, and automatic
native consumption claims a new epoch only for the matching reservation.
Consumed/steered/deleted reservations retire while original client IDs remain
recoverable. Same-principal reconnect can reclaim only an explicitly disconnected
owner; a live competing connection cannot steal control. Seven focused authority
tests, local-host regressions and host typecheck pass. Real DSH smoke now covers
queueing during a held response, automatic consumption, original client ID,
actual WebSocket disconnect/resume and interruption by the new owner.
Queued inputs across whole-host restart and additional contention remain open.

Copied HyperNode TextDeltaPacerController and source tests; actual outgoing
notifications now pace text and hold Item/Turn completion until drain. Canonical
execution history stays immediate, presentation queue is disposable. Interrupted
completion flushes prior text; close cancels late callbacks. Execution telemetry
hooks now record bounded event/phase counters and terminal timing, never content.
Separate runtime/diagnostics/read preserves runtime/status/read compatibility.
178 DSH tests and real-engine tool/interrupt/restart/image smoke pass; host
typecheck passes. Actual UI pacing inspection and final whole-goal audit pending.

Owned DSH permission metadata now comes from sandboxPolicy.resolve,
approval.overrideOf/config and permissionPresets rather than fixed workspace
claims. Named profiles use the canonical setter and flush; arbitrary
unsupported policy overrides are rejected instead of silently ignored.
Confined file policy projects as externalSandbox with explicit DSH metadata,
not a claim of Codex OS sandbox enforcement. Real-engine read/switch/restore,
host scenario smoke, projection tests and typecheck pass.
Generation intent carries the exact named permission preset; new seed Agent
is set before publication. Custom unmatched policy recovery currently refuses
rather than broadening authority, and remains unfinished. External DSH metadata
and full UI profile-selection acceptance remain open.

Generation creation now persists exact prepared seed and source intent before
native creation. Resolution resumes an already-persisted unpublished generation
only if its seed prefix exactly matches that intent, then flushes and publishes
the checkpoint. Mismatching orphan content is rejected. Fault-injected store/
recovery tests pass and existing real DSH generation/race/restart smoke passes.
The exact pre-checkpoint process-kill window still needs real-engine acceptance,
not merely the injected failure. Remaining full goal retained.

Checkpoint/routing commit gap now has durable reconciliation: pending routing
intent persists prior sequence/Turn coordinates; committed checkpoint retains
original seed coordinates across later captures. Startup/restart publishes
only matching complete evidence, idempotently, without generating another
native session. Missing evidence remains hidden. Five focused store/routing
tests and the real DSH restart/crash scenario pass; typecheck passes.
Startup failure cleanup closes the capability link, databases and owned child.
Gap before native checkpoint commit, route lineage corner cases, indexed
history and remaining full objective requirements still need work.

Automatic engine restart now creates a checkpoint-derived native generation,
publishes durable logical/native routing coordinates, and re-registers host
capabilities on the new native Agent. DshRoutedClient maps requests/events/list
and merges historical generations while suppressing model seed from UI history.
Real DSH explicit restart and SIGKILL recovery tests pass with stable historical
Item IDs, resumed inference and capability calls; staged native generations
never appear as separate UI Threads. Remaining: recovery between checkpoint
commit and routing commit, route offsets for all replacement/lineage variants,
and bounded indexed history performance. Full objective not complete.

Generation transition is serialized per logical session; publication follows
seed persistence and checkpoint commit, with failed handles disposed. Plugin
startup reloads committed generation identities. Real DSH race test publishes
only one .g2 from two concurrent requests, then restarts the actual engine and
resolves/readbacks .g2 including tool history. Checkpoint validation rejects
source changes, stale generations and backwards watermarks. Main-host routing
to this committed identity remains unconnected; the goal stays active.

Checkpoint implementation now copies HyperNode surface projection function
bodies, commits watermark+surface only after native flush, and atomically
renames private checkpoint files. Plugin captures terminal surfaces and exposes
authenticated checkpoint/generation controls. Real DSH creates a .g1 Agent
from source surfaceToSeed and reads tool results/assistant messages back.
Five tests cover source replacements, relational tool seeds, interrupted tails,
flush failure, stale-generation rejection and invalid checkpoint refusal.
Automatic logical/native identity routing and recovery remain pending.

Added capability-negotiated loopback HTTP RPC for WebSocket hosts and the
Workbench fallback consumer. Limits: loopback-only credential-free targets,
no OpenCraft/DSH control ports, stripped auth/cookie headers, bounded bodies/
responses and deadlines, owner-connection cancellation and disconnect cleanup.
Focused rejection/redirect/header tests and both host/runtime typechecks pass.
The original browser iframe test is rerunning through this real transport.

Result: original real-browser test now passes. DSH invokes production broker,
OpenCraft browser opens the local fixture, tab-list result returns, and iframe
heading is visible. Screenshot /tmp/opencraft-dsh-actual-browser.png inspected.
Existing conversation resume, subsequent sends and page reload also pass.
No paid requests or real credentials. Full goal remains incomplete.

Real-browser acceptance now drives open_in_vela and browser_use through actual
DSH and Workbench handlers. It uncovered two genuine gaps: resumed threads did
not re-register dynamicTools (added capability-negotiated registration after
hydration), and browser JSON Schema anyOf/range constraints are outside DSH's
subset (full Ajv validation retained at execution, model-facing schema lowered).
Native plugin smoke accepts the actual browser definitions. UI shows a real
browser tab and returns its result to DSH, but iframe loading fails because the
WebSocket Host has no loopback HTTP transport. This remains an explicit failure,
not bypassed with a different URL. Screenshot /tmp/opencraft-dsh-browser-failure.png.
Full browser acceptance, schema-negative tests, explicit Ajv dependency closure
and registration update semantics remain pending.

Capability Skill now materializes in a private hashed per-session directory,
registers through createScope(pluginContext, agent), and appears in actual
native skill.list. Unregister revokes it and removes its file. Real plugin
smoke proves registration, tool execution/return and Skill revocation.
AppServer skills/list uses complete engine definitions (path/source/invocation)
for the opened conversation rather than a fake empty result. Missing physical
paths are surfaced as errors rather than invented. Force-reload semantics and
pre-conversation discovery still require further audit. Initial direct
agent.ctx.skills access failed dependency checks; corrected to plugin-owned
scoped registration without bypassing injection.

Production local-host startup now installs the authenticated engine plugin
through a private temporary patch, with packaged plugin resource mapping.
CapabilityLink polls engine requests, resolves current execution owner/epoch,
dispatches the owning WebSocket tool call and returns text results; cancellation,
disconnect and endpoint generation changes retire pending calls. Restart
re-registers owner-scoped tools. Only that owner's disconnect unregisters them.
Real host smoke now exercises a client capability through actual DSH and the
broker, in addition to prior internal-tool/restart scenarios. Actual browser
behavior, Skills and rich non-text results are still pending.

Engine capability plugin now loads through real DSH --patch. Private loopback
control requires a token; tools register in agent.ctx.tools, not globally.
Real synthetic model smoke verifies schema visibility, actual tool invocation,
host return and the following model request. Production main/broker wiring,
Skill materialization and actual browser endpoint remain pending.
Validation discoveries: bare imports from the app tree cannot resolve engine
dependencies (pass bundled tools module URL); defineTool parameters are a
property shorthand, not AppServer JSON Schema (use validated raw ToolDefinition).

Capability host broker now implements thread/connection-scoped registration,
directed item/tool/call, exact-owner result handling and timeout/cancel/
disconnect cleanup. WebSocket thread start/resume registers dynamicTools;
responses route to the broker before ordinary interactions. Two focused
broker tests and existing local-host tests pass; host typecheck passes.
Engine invocation is NOT connected yet and no browser capability end-to-end
claim is made. DSH's web API has no dynamic tool registration method; next
work must load a runtime plugin or the source worker and inject real Skills.

Latest: connected reference transparent-thread-history.ts for Turn/Item pages,
summary/notLoaded views, sorting and source cursors. Native pages are assembled
before fold; read(includeTurns) no longer silently cuts off at 50 messages.
165 DSH tests, local host typecheck and real Workbench→DSH synthetic smoke pass.
Tests include page boundaries inside Turns, filtering and malformed/cross-method
cursors. Source unknown-Turn behavior is an empty filtered page. Skills and the
full six-area objective remain incomplete. Type index-signature mismatch was
resolved; no changes to reference paging behavior.

Started complete migration, retaining all six requested requirements. Reading current local transport and HyperNode admission/lease/journal implementations. No completion claims for unfinished areas.

Imported unchanged execution and lease tables plus durable journal. Added local
SQLite storage adapter; two tests pass covering competing connections, stale
epochs, late native starts and previous-boot orphan fencing. No production
dispatch wiring yet: request/epoch correlation with queued native events must
be explicit, not guessed from whichever waiter runs next.

Connected per-WebSocket identity and persistent authority to normal turn/start,
steer and interrupt. Native start prefixes are withheld until the corresponding
user/message source.rpcId matches the admission-specific execution token.
Synthetic tests reject late old-request starts; the real Workbench→DSH smoke
passes through this connected path. Queue admission, disconnected-owner
reacquisition, original client identity in historical replay and complete
server-side bypass audit remain open within requirement 1. Other five
requirements remain pending.

Persisted execution-token→original client-message identity, with thread-scoped
history restoration across process boots. Queue mutations now use the same
write-lease guard, rejecting a different connection while execution/editing
is owned. Automatic queue admission and disconnected owner transfer remain
open. Imported full HyperNode shell classification plus original 117-case
corpus and 130 tests; all pass. Classification is display metadata only.
