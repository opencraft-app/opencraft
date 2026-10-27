# DSH / AppServer protocol boundaries

## Ownership

- DSH owns sessions, durable events, running turns, queued messages, pending
  questions and approval decisions. The bridge must not infer an answer from
  a tool label or terminate a wait merely because a renderer disconnected.
- `DshClient` owns HTTP envelopes, per-request transport deadlines and
  multiplexed event envelopes. A caller-owned cancellation signal narrows the
  request lifetime; it never replaces the finite transport deadline. The client
  preserves the native `rpcId`; `/api/respond` uses `client-response`, not
  `client-request`.
- `DshRoutedClient` owns bounded history-window reads and shared in-flight work.
  It does not maintain a second full-history index. Every shared flight must
  settle and be evicted after success, failure, cancellation or timeout so one
  stalled native request cannot poison later restores.
- `ThreadLifecycle` serializes operations for a logical Thread. It does not own
  another transport timeout or terminate native DSH work; its delegates must
  already have bounded lifetimes at the transport boundary.
- `DshInteractions` owns only pending wire correlations and response translation.
  It replays pending requests to subscribers, suppresses simultaneous duplicate
  responses, and withdraws requests on DSH resolution or an accepted receipt.
- Each downstream WebSocket tracks which threads it opened and which requests
  it was offered. Initializing a client or probing a connection is not permission
  to answer every pending question on the host.
- `DshToolProjection` joins calls/results for both history and live projection.
  The result identity is `message.source.callId`, and output is nested inside
  `message.content[].content`. Never invent a shared `unknown` item ID.

## Mapping

| Native input | AppServer output |
| --- | --- |
| question/requested + envelope rpcId | item/tool/requestUserInput server request |
| question/resolved | serverRequest/resolved |
| approval/requested | item/commandExecution/requestApproval, allow once or reject only |
| approval/resolved | serverRequest/resolved |
| JSON-RPC answer | POST /api/respond using the original DSH rpcId |
| tool/call | item/started with stable call identity |
| tool/result | item/completed for the same item, preserving name and arguments |
| turn/end with unfinished tool | unsuccessful tool completion before turn completion |
| foreground bash | commandExecution with commandActions, outputDelta, exitCode and duration |
| todo/write | turn/plan/updated and a stable plan item for history |
| goal/change | thread/goal/updated or thread/goal/cleared, independent of TODO |
| thread/goal/get | live ctx.goals view, or cold session.history goal projection |
| thread/goal/set and clear | native ctx.goals CAS mutation and Session durability |
| assistant/message | deferred phase: commentary before further work, final_answer on successful turn end |
| thread status `notLoaded` or `idle` | neutral Workbench Thread state; no attention marker |
| thread status `active` | running Workbench Thread state |
| thread status `systemError` | explicit error state; never a running or review marker |

`DshTurnProjection` is the shared ordered fold for history and live events.
An unfinished message keeps a null phase until its execution boundary is known.
Command classification is display-only and conservative: compound shells,
expansions and unsupported flags remain unknown. Background bash stays a generic
tool result rather than pretending its process has exited. Foreground result
markers distinguish nonzero exits, timeout and signals from success.

Goal mutation belongs to `ctx.goals` on the exact live Agent, serialized through
its native thread port and flushed through `ctx.sessions`. Create/edit/pause/
resume/complete/block/clear use the service's current id/revision; native goal
tools keep their own human/automatic-round policy. No second goal database or
OpenCraft continuation loop exists. The native goal-round driver owns scheduling,
round limits, cancellation and durability checkpoints.

An explicit active Goal mutation authorizes a process-local continuation owner
before native arming. A tool-created Goal inherits its admitted human execution.
Only native `source.kind=goal` with the exact authorized goal id/revision and a
new positive round receives a new execution epoch. A pending human admission
cannot be stolen. Armed goals outlive their originating socket; reconnect by
the same actor reclaims the execution and future round owner. Engine loss clears
these grants. Session-scoped `goal/change` notifications bypass Turn admission,
so pause/complete/clear remain observable between turns. History replay never
creates a continuation grant.

Cold restore and fork retain durable phase/objective but native activation is
disarmed. The optional `execution.activation` Goal projection lets the existing
UI show Resume even for a durably active, disarmed Goal. Reading never loads or
arms an Agent; explicit Resume rearms it. An armed Goal prevents idle unload.
Completing or clearing a Goal stops subsequent rounds; an already executing
round may finish its final answer. Turn interruption uses the native driver's
cancellation behavior rather than a parallel stop mechanism.

DSH exposes no goal token/time accounting: required counters remain zero and
`tokenBudget` is null. The Goal capability declares `usageAccounting:false`, so
shared UI omits elapsed/token metrics. Non-null token budgets and unsupported
statuses are rejected. Native round limits are not token budgets. Hosts without
the native Goal port remain read-only; older capabilities without the optional
accounting flag retain their existing behavior.

Generic tool approvals have no fabricated shell command: command remains null
and reason names the tool. Persistent grants are rejected, not silently widened.
DynamicToolCallStatus has no interrupted variant; the tool becomes failed while
its owning Turn carries the interrupted status.

## Verification and remaining limits

`npm run test:dsh-bridge` covers native envelope round trips through real HTTP/
WebSocket transports with a fake DSH server, downstream reconnect, preflight
isolation, response races, cancellation during context lookup, and tool identity.
It does not replace a live model/macOS acceptance test.

This is not a claim of complete DSH feature parity. Recovery of missed upstream timeline events,
history pages beginning after a tool's call, and model-modality catalog propagation
still need explicit protocol work. Do not add renderer heuristics or mark these
capabilities supported merely because a generic tool card can be displayed.

The Workbench owns only the presentation of projected Thread state. A review
marker requires a real product attention source; restore not yet loaded is not
review work. Sidebar colors consume semantic design tokens and do not reinterpret
transport or AppServer lifecycle state.

## Indexed assistant blocks and thread instructions

The local `DshBlockProjection` supplements the fixed HyperNode interpreter.
Native `block-start` tracks block identity without creating empty reasoning
Items; `block-end` reconciles the complete indexed block. Reasoning closes
before text begins, including streams without explicit block-end. A final
assistant envelope corrects the same reasoning Item rather than creating it
again. Text retains deferred commentary/final phase ownership at execution
boundaries. Live delivery and history replay use this same ordered fold.

`baseInstructions` overrides the native scoped deployment persona slot; harness,
tools and repository context remain native contributions. `developerInstructions`
is an additional scoped section. RPC strings remain literal, including `{{...}}`.
Omitted/null RPC fields retain the saved value;
an empty string suppresses the base persona or removes the additional developer
section. Changes affect subsequent prompt assemblies without recreating or
interrupting the Agent. A history-only resume without overrides remains lazy. An external engine without
the native thread port rejects explicit overrides instead of silently dropping them.

Native Session creation metadata holds initial choices; the owned non-surface
`opencraft/instructions` event records later complete choices. There is no user
message injection or parallel transcript store. The locked rc.2 runtime exports
its accepted event vocabulary but lacks a plugin registration method: the local
controller registers exactly this event for its composition lifetime. Unknown
unrelated required events still fail closed. An older Host without this
registration cannot interpret logs containing the extension; preserve the data
and upgrade the Host instead of removing events or silently ignoring instructions.

Fork inherits settings at the selected native history boundary and applies
explicit overrides. Cold resume, engine-generation recovery and live updates
share one scoped controller. Legacy catalog instructions are migration input
only when the native session has no instruction state; they cannot overwrite
newer native choices during ordinary activation. Existing sessions that never
persisted their old baseInstructions cannot recover that previously discarded
value. Prompt contents and arbitrary provider errors are not diagnostic output.

`tests/execution/dsh-blocks.test.ts`, `tests/execution/dsh-instructions.test.mjs` and
`scripts/smoke/execution/smoke-dsh-instructions.ts` exercise block completion/reconciliation,
scoped isolation, bounded forks, concurrent resumes and real locked-runtime
requests across whole-Host and engine-generation recovery. Inference in the
smoke uses an isolated local synthetic endpoint. These corrections do not prove
that prompt wiring caused any particular model's communication frequency.

The native synthetic fixture `npx tsx scripts/smoke/execution/smoke-dsh-goal.ts` exercises the locked runtime, HTTP/WebSocket transport, native Goal tools, same-session continuation and cold persistence. Only inference is a local synthetic endpoint; it does not assert paid-provider or device behavior.

## Shared Host schedules, background completion and questions

`@opencraft/host-schedules` owns one scheduling state machine, schema and
`conversation-schedules.sqlite` per Host data root. Codex and DSH implement only
`ScheduleExecutionPort`; the protocol, catalog and task panel are shared. DSH
uses an explicit Host scheduler principal, serializes against thread lifecycle,
waits for human/queued/armed-Goal work and records the stable occurrence as the
client input ID before native submission. Missing/ambiguous receipts and previous
boot orphans become unknown for explicit review; they are never replayed. Archive
pauses future occurrences. Browser lifetime does not own the timer. Native DSH
Schedule is a session-local reminder with different cold-start and recurrence
semantics; it is not enabled as a parallel product scheduler.

Background completion authorization uses the native jobs registry's exact Agent
and ownerSession at live job creation, plus the producing input RPC. A completed,
unreported owned job can lend that execution's authority to one exact tool-jobs
notice message through the private capability bridge. Unowned jobs, cold snapshots,
other plugins, ambiguous producer batches and replayed notices cannot mint a
continuation. The native notice has no job ID: multiple eligible producers are
conservatively refused. Engine restart clears these process-local proofs; active
owned background jobs prevent idle unload. Notice text and labels are not used as
authorization. Native wake budgets and inject-versus-followup choice remain native.

Native `multiSelect`, `detail` and `intent` survive the additive shared question
projection. Both renderers use the same draft/toggle/aggregation functions;
multi-select starts empty, allows independent choices plus free text, and requires
explicit Submit. Single-select retains its existing advance behavior. Plan detail
renders through each platform's existing Markdown document surface. Generated
Codex question types are unchanged. `smoke-dsh-host-services.ts` exercises real
locked DSH with synthetic local inference, durable cold schedules, background
wake and native questions; it is not paid-provider or physical-device evidence.
