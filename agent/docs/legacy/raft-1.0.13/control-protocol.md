# Control protocol baseline（冻结证据）

## Connection

- URL: replace the server URL scheme with `ws`/`wss`, append
  `/daemon/connect`.
- Authentication: `Authorization: Bearer <Computer credential>`.
- Payload: one UTF-8 JSON object per WebSocket message.
- Envelope discriminator: `type`.

## Resilience

- Reconnect: deterministic 1, 2, 4, 8, 16, then 30 second delays by default;
  30 seconds remains the cap.
- Inbound watchdog: after 70 seconds without an inbound frame send
  `{"type":"ping"}`; terminate and reconnect if the next deadline also
  expires.
- `legacy_machine_key_migrated` is terminal and disables reconnect.
- Unknown event types remain connected and are reported diagnostically.
- While disconnected, only `agent:activity` is retained. The latest activity
  per Agent replaces the prior one, first-Agent insertion order is preserved,
  and a newer status/session/runtime-profile launch identity invalidates stale
  activity. Other outbound frames remain non-replayable.
- On reconnect, pending activity is replayed before `ready`; normal
  session/profile/reminder snapshots follow through the connect handler.

## Delivery

A non-transient `agent:deliver` frame is acknowledged only after validation
and insertion into the local ordered inbox. A transient frame is acknowledged
only after its current lifecycle route accepts it, and is not inserted into
the durable inbox. If an idle transient requires a restart and credential
preparation fails before any pending buffer accepts the message, no
`agent:deliver:ack` is emitted.
`agent:deliver:ack` is a transport receipt, not a semantic completion receipt.
Delivery correlation requires either top-level `deliveryId` or nested
`message_id`/`id`, not both. When `deliveryId` is omitted, the Computer uses
the message identity in a separate durable idempotency domain and omits
`deliveryId` from the ACK. Reminder wakes may instead carry `deliveryId` while
omitting a nested message identity; the local inbox uses the receipt ID as its
stable item identity without modifying the message payload. An explicitly
empty, null, or non-string `deliveryId` remains invalid.

The optional wire `launchId` is not an input fence. Recovered 1.0.13 routes
delivery by Agent identity, so an already committed message labeled with a
superseded launch still reaches the current Agent state. Launch and session
fences continue to apply to lifecycle replacement and Runtime output.

Delivery behavior depends on the current Runtime state:

| Runtime state | Durable delivery | Transient delivery |
| --- | --- | --- |
| No Agent record | Commit and ACK; Runtime routing reports no active Agent | ACK and drop |
| Reserved, queued, or starting | Buffer in sequence and flush after start | ACK and drop |
| Live and busy | Deliver through the Codex busy-input path; preserve rejected input for bounded retry | ACK and drop |
| Live session after turn completion | Start a new Codex stdin turn | Start a new Codex stdin turn |
| Idle restart snapshot, no process | Buffer, mint fresh launch capability, and restart the currently remembered launch | Mint fresh launch capability and restart with a one-shot concrete system-notice prompt; ACK only after acceptance and do not durably commit |
| Idle snapshot in spawn-failure cooldown | Buffer for the next restart | Preserve the raw nested message for the next eligible same-launch start, ACK, and do not spawn immediately |
| Sticky terminal state | Buffer for explicit stop/start recovery and repeat inactive/error state | ACK and drop without lifecycle side effects |

A new-launch `agent:start` reservation does not replace a live Codex process.
It records a candidate launch identity while credentials and local capability
state are prepared; successful start rebinds the existing session. Preparation
failure cancels only that reservation and must not stop the live launch.

## Evidence provenance

Field-level contracts are recorded in `protocol-evidence.json`. Each contract
declares its direction, evidence status, required and optional fields, evidence
line ranges, and a source identifier. Tests resolve the source path and verify
the complete evidence-file SHA-256 before accepting the contracts. Sanitized
fixtures must contain every field marked required by the ledger.

Fixture provenance is separate from wire evidence. The ledger pins the SHA-256
of all four fixture corpora and declares that they are not network captures:
their values are synthetic and sanitized, while their shapes map to observed
contracts. Deliberate forward-compatibility fields that are not evidence-backed
are listed by JSON path under `inferredPaths`; an empty map means no fixture
field path is being presented as inferred.

The ledger covers all 49 frozen control contracts: 25 cloud-to-Computer
handlers and 24 Computer-to-cloud emitters. It supports fixed required fields,
nested requirements, alternative-required groups such as the observed
`operationId`/`requestId` aliases, and per-evidence source overrides when a
forwarded payload is constructed in the Computer service rather than the
daemon.

## Activity probes

`agent:activity_probe` requires `agentId` and `probeId`; `purpose` is optional
diagnostic context. The response uses `agent:activity` and preserves the last
launch-fenced activity display, status kind, detail, detail kind, and launch
identity. It generates a fresh monotonic `clientSeq` and `producerFactId` and
sets `isHeartbeat:false`. A probe does not replace the cached activity state.

## Runtime trajectory

Runtime text and reasoning deltas are not forwarded one frame at a time.
Adjacent deltas of the same kind and launch are accumulated for 350 ms and
published as one `text` or `thinking` trajectory entry. The emitted text is
bounded to 2,000 characters plus a truncation ellipsis. A change of entry kind,
tool start, turn completion, or Runtime error flushes pending text before the
new lifecycle frame.

Codex `item/agentMessage/delta` is user-visible only when its phase is absent
or `final_answer`; commentary and other non-final phases must not become
assistant trajectory text. A phase supplied by a delta applies only to that
notification and is not retained for later deltas. When a delta omits phase,
it may inherit phase previously established by the item's started/completed
lifecycle frame. Every later same-ID lifecycle frame replaces that state;
absent or empty phase clears an older commentary classification. Completed
fallback output does not inherit the state: it is classified solely from the
completed notification's `item.phase`, with absent phase treated as
user-visible. Receipt of a delta notification fences the same item's completed
fallback even when its delta text is empty. That empty delta does not itself
create trajectory progress, so a subsequently completed turn can still follow
the official zero-evidence diagnostic/error/inactive path.
An `item/reasoning/summaryTextDelta` notification follows the same identity
rule independently: even an empty delta fences the completed reasoning
fallback without emitting thinking or marking progress.
`item/reasoning/textDelta` has no corresponding fallback fence: it counts as
internal progress only when `delta` is a non-empty string. Empty or
structurally invalid values emit nothing and leave zero-evidence turn
classification unchanged.
An unstreamed completed reasoning item follows the same evidence boundary:
its string summary entries are joined and trimmed, and only non-empty result
text marks progress and emits thinking. Empty or missing summary text is
inert, while the streamed-item fence is still cleared.
A Codex `commandExecution` projects to a
`tool_start` entry with tool name `shell`, the bounded command input, display
`Running command…`, and detail kind `running_command`. Commands longer than
100 JavaScript UTF-16 code units are represented by the corresponding prefix
plus an ellipsis, matching the 1.0.13 display summary. Astral characters count
as two units. If the boundary cuts a surrogate pair, the raw control JSON
contains the same unpaired high-surrogate `\uXXXX` escape as official 1.0.13;
decoding that frame produces U+FFFD before the ellipsis. Both raw bytes and
decoded projection are pinned by the installed differential transcript.
Codex `webSearch` and `collabAgentToolCall` project to tool names
`web_search` and `collab_tool_call`, with official display labels
`Searching web…` and `Collaborating…` respectively. Web-search query text is
the public input summary; collaboration prompt/tool data is intentionally not
included in the public activity summary.
Unknown Codex tool display labels, including long MCP-derived names, are
bounded to 20 characters plus a truncation ellipsis before the normal activity
ellipsis. This display bound does not alter the full `entries[0].toolName`.

Codex warning/configuration/deprecation diagnostics select and bound each
summary, detail, message, and path field with JavaScript string behavior before
fallback or composition. ECMAScript whitespace is trimmed (including U+FEFF
BOM but not U+0085 NEL). Text at or below 1,000 UTF-16 code units is unchanged;
longer text is `slice(0, 999) + "…"`. The bound therefore counts an astral
character as two units without splitting valid Go UTF-8 bytes.

Codex model discovery starts a short-lived app-server, completes
`initialize/initialized`, and reads at most five `model/list` pages. Both
`data` and `models` page shapes are accepted. Hidden or identity-less entries
are excluded; default model, supported reasoning efforts, and service tiers
are preserved in `machine:runtime_models:result`.

The Codex command is selected freshly for Probe, discovery, and Start. Ordered
candidates are deduplicated and must pass a bounded `app-server --help`
compatibility probe; Probe also reports the first nonempty `--version` line and
prior rejection diagnostics. A usable app-server model result is authoritative.
Routine spawn, handshake, RPC, page, timeout, or zero-usable-model failure
falls back to the first existing `models_cache.json` under the resolved
`CODEX_HOME` root or its nested `.codex/`, with the adjacent `config.toml`
providing the optional default. Only complete live/cache exhaustion produces
`machine:runtime_models:result` with `error:"unsupported"`; caller cancellation
remains an operation error.

An app-server `error` notification with `willRetry:true` is internal progress,
not a Runtime failure. A completed turn with no visible or internal output is
still a normal idle boundary under the installed 1.0.13 protocol; the client
must not invent an empty-response error.

A terminal app-server `error` notification uses its top-level message, then
its nested `error.message`; if neither is usable, the exact fallback is
`Unknown Codex app-server error`. An interrupted turn with a native error
message is reported as `Codex turn interrupted: <message>`; a failed turn keeps
the native message without that prefix.

`configWarning`, `warning`, `guardianWarning`, and `deprecationNotice`
notifications produce a bounded `system` trajectory entry while preserving
the current activity state. A waiting `thread/status/changed` notification is
handled the same way. Its `activeFlags` array is filtered to string
`waitingOnApproval`/`waitingOnUserInput` values without deduplication. The
message label depends on membership, while `Active flags: ...` detail preserves
the filtered sequence's exact order and multiplicity. A `systemError` thread
status enters the normal Runtime
error path and preserves `codex_native_reason` plus
`nativeReasonPresent:true` when the app-server supplied the reason. Without a
native reason, it first emits a `Codex warning` system entry stating that the
thread entered system error without a reason, then emits the fallback Runtime
error with `daemon_fallback` and `nativeReasonPresent:false`.
Status-local `message` and `error.message` reasons are trimmed and bounded
with the same ECMAScript-whitespace/1,000-UTF-16-unit rule as diagnostics
before becoming public `runtime_error` detail. Top-level notification
`message`, then `error.message`, form a separate fallback path: JavaScript
`trim()` determines whether each string is usable, but the original untrimmed
and unbounded value becomes the native reason. A whitespace/BOM-only root
therefore falls through, while NEL and meaningful boundary whitespace are
preserved.
Status selection uses nullish precedence: a present top-level `status` is
authoritative even when empty, malformed, or missing a usable `type`; nested
`thread.status` is selected only when top-level `status` is absent or null.

While the last launch-fenced activity is `working` or `thinking`, the Computer
repeats that state every 60 seconds. A heartbeat preserves the last display,
kind, detail, detail kind, and launch, omits trajectory entries, generates a
fresh sequence/provenance pair and timestamp, and sets `isHeartbeat:true`.
Publishing a non-transient state or ending the runner event loop stops the
timer. Probe replies remain separate: they set `isHeartbeat:false`, do not
start or reset the timer, and follow the smaller probe envelope.

## Runtime progress watchdog

Runtime progress is measured from real Runtime events, including internal
events such as usage and tool output that do not produce an activity frame.
The per-launch record stores the last event time, event kind, stale marker,
and a monotonic event version. The event version fences the Go event queue:
an event already emitted by Agent Manager but not yet projected by Core
suppresses an obsolete stall or recovery decision.

At each transient-state heartbeat, 15 minutes without a Runtime event triggers
a native process liveness probe. Only an explicit `alive` result suppresses
the diagnostic. `dead` and `unknown` emit:

```text
activity=error
detailKind=runtime_stalled
detail=Runtime stalled: no runtime events for <floor(minutes)>m (...)
entries=[]
```

The optional context includes the last non-empty activity detail and the
number of queued inbox messages.

A newly committed queued delivery can instead prepare a same-launch recovery.
Agent Manager atomically checks the observed progress version, appends the
delivery, detaches the old RuntimeSession, and emits:

```text
activity=working
detailKind=stalled_recovery
detail=Restarting stalled <runtime-id> runtime for queued message
entries=[]
```

Only the first caller owns the restart; later deliveries join its bounded
pending queue. Controller reuses the remembered start parameters, creates a
fresh credential/capability launch, and the replacement Runtime receives the
queued deliveries in order. Wire-level duplicate deliveries are ACKed again
but are not queued twice.

For direct-stdin Runtimes such as Codex, recovery additionally requires a live
session and zero outstanding tool calls. Tool calls increment a launch-local
balance; tool output decrements it without going below zero; turn completion
resets it. A message received while the stale Runtime still owns a tool remains
queued and may use ordinary direct steering, but it cannot terminate that
Runtime through stalled recovery until the tool boundary is observed.

## Repeated Runtime error fence

Recoverable deterministic Runtime errors can otherwise create an endless
restart loop. The Computer keeps an Agent-scoped fingerprint outside the live
process and trips on the third consecutive eligible error with the same
fingerprint.

Before hashing, diagnostic text redacts bearer/API tokens, emails, URL
credentials/queries, and user-home paths. It is then lower-cased, long hex
runs become `<hex>`, integer runs become `<num>`, whitespace is collapsed,
and the first 16 hex characters of SHA-256 form the fingerprint.

Meaningful progress (`thinking`, assistant text, tool call/output, or turn
completion) and explicit stop reset the fence. Action-required authentication,
zero-evidence Codex completion, and sticky unsupported-model errors do not
contribute.

On attempt three the Computer removes Runtime residency and sends the inactive
status before the final error activity. Every Runtime error activity includes
an error `status` trajectory entry and a `runtimeError` object containing the
normalized class, reason, scrubbed fingerprint, and reason provenance. The
final fenced activity has no `launchId`, because the fenced launch has already
lost residency when the activity is emitted. The visible detail is:

```text
Runtime stopped after 3 repeated runtime errors with the same fingerprint (<fingerprint>). Last error: <message> Restart after the runtime/tooling issue is fixed.
```

## Codex silent-turn evidence fence

Codex maintains evidence independently for each accepted native turn. A
successful non-empty `turn/start` or `turn/steer` response is associated with
string `result.turn.id`, or the expected active turn for busy steering. A
root-only `result.turnId` is not accepted as correlated input evidence. The
association is recorded inside the JSON-RPC response boundary so a following
`turn/started` notification cannot win a caller-goroutine race.

After `turn/started`, assistant/reasoning/tool/internal progress or a valid
`thread/tokenUsage/updated` payload proves Runtime activity. If
`turn/completed status=completed` arrives without such evidence, the Computer
emits a `Codex warning`, then `codex_zero_evidence_turn_completed`. Proven
non-empty input uses “returned an empty response”; otherwise it uses
“completed without a response”.

This failure is sticky terminal rather than part of the repeated-error fence.
The Computer sends inactive before the error activity, removes live Runtime
residency, and stops Codex. Later deliveries remain ACKed and buffered while
inactive plus the cached error activity are repeated without starting another
Runtime. The cached replay retains the terminal launch ID, contains one status
entry, and intentionally omits a fresh `runtimeError` diagnostic envelope. A
completion notification without a preceding `turn/started` remains an
ordinary empty completion.

Sticky terminal recovery is a two-frame lifecycle transition:
`agent:stop` for the terminal launch followed by `agent:start` with a new
launch ID. A direct start is rejected. Stop is an ordering barrier, but it
does not discard deliveries buffered during terminal residency. The new
Runtime receives those deliveries before normal live delivery resumes, and a
buffered entry is retired only after the Runtime accepts it.

## Launch fencing

Every runtime start has a launch ID. Activity, session, output, and errors from
an older launch are ignored once a replacement launch becomes current.

## Agent process residency

Logical Agent residency is separate from a live Runtime process:

- `ready.runningAgents` contains live processes only.
- A process that exits after a completed turn retains a same-launch restart
  snapshot with the latest Runtime session and profile.
- A process that crashes without completing its current turn becomes inactive
  and does not retain a restart snapshot.
- A non-transient delivery to an idle Agent is committed and queued before a
  fresh launch credential and local capability token are prepared.
- Deliveries received during initial credential preparation, Runtime start,
  pending-input flush, or an active cooldown remain ordered and accepted.
- A transient that triggers idle restart is not accepted when credential mint
  exhausts all retries, so it receives no ACK. A later transient received while
  that cooldown is active is accepted into the start buffer, retains full
  nested wire metadata, and is rendered once into the next eligible
  same-launch Codex start. An explicit resume includes it in the startup
  prompt. If a later one-shot transient wakes Codex after cooldown expiry, that
  later wake remains the initial prompt while older accepted messages move as
  one aggregated idle inbox notice to the registered Runtime's turn boundary.
  Failed resume or transfer attempts keep the buffer; stop and launch
  replacement clear it. A completed Runtime that closes before sending the
  notice drops transient pending items but retains durable ones.
- Inbox notices group messages by target, sort rows by descending latest
  sequence and then target, and sort each target by sequence/message ID. Row
  flags are the lexical union of thread, DM, task, mention, and non-member
  mention facts. Non-member mention renders reply guidance; the latest
  hint-bearing message contributes the fixed `attention_hint` JSON projection,
  including forward-compatible threshold fields and JavaScript-visible string
  characters.
- An ordinary durable wake for a newly spawned Codex Runtime is both the
  initial projected startup input and a live startup-inbox item. After the
  initial turn completes it starts one equal idle turn. Older messages accepted
  during credential cooldown are appended to the durable wake in both
  projections and consumed only after successful Runtime start. A transient
  one-shot wake is excluded from that continuation, and a live-process rebind
  uses only its immediate delivery path.
- Runtime spawn failures use a 1-second exponential cooldown capped at
  30 seconds. Exhausted Runner credential mint failures use a 60-second
  exponential cooldown capped at 10 minutes.
- Explicit stop removes the restart snapshot, advances a stop epoch, revokes
  local launch capabilities, and asynchronously revokes the managed cloud
  Runner credential. Old restart work cannot make the Agent current again.
- Reconnect session/profile and reminder replay includes idle snapshots even
  though they are absent from `ready.runningAgents`.

## Native session diagnostics

For Codex, the configured `CODEX_HOME` (or the isolated home directory's
`.codex`) is the initial Runtime root. A nonblank app-server initialize-result
`codexHome` replaces it for that live launch and is resolved against the Agent
working directory. The launch-fenced observed root is reused for live
`agent:runtime_profile.facts.sessionRef`, transcript/feedback lookup, and Codex
skill discovery; idle/restart snapshots retain the configured fallback.
Recursive session discovery below `<runtimeHome>/sessions` and
`<runtimeHome>/.codex/sessions` is capped at depth 8 and 10,000 entries.
Candidates must remain under an allowed root, be regular files, and must not
be symbolic links. Reads are capped at 10 MiB and report truncation explicitly.

Before a transcript is returned or uploaded, managed Agent/Computer tokens,
launch capability tokens, Bearer values, authorization-token fields, and HTTP
URLs are replaced with bounded placeholders. When Codex has no discoverable
native JSONL, the client writes an independently generated handoff record under
the Agent workspace using a mode-restricted atomic replacement.

Codex skills are discovered below `<runtimeHome>/skills`,
`<runtimeHome>/skills/.system`, `<runtimeHome>/.agents/skills`, and the
workspace-local `.codex/skills`/`.agents/skills` roots. Host
`~/.agents/skills` is an implicit fallback only when no effective
`CODEX_HOME` was explicitly configured.

Feedback collection computes the observed 15-minute report window, compresses
the already-redacted transcript with gzip, hashes the exact compressed bytes,
requests `daemon-trace-bundle:create` scope attestation from the attached
server, creates a worker upload session, and sends the bundle only to the
returned signed target. Redirects are never followed. The Computer credential
is used only for the server attestation request and is never forwarded to the
worker or signed upload target. Signed targets cannot override transport-owned
`Host`, `Content-Length`, connection, or transfer-encoding headers.

## Process differential policy

The isolated process harness supports ordered steps and correlation selectors.
Selectors can address nested object/array paths such as
`entries.0.kind`, allowing the harness to select one trajectory frame without
depending on incidental startup frames.
This permits a single official-vs-Go scenario to wait for Codex session
initialization, select the exact `probeId` activity response despite incidental
startup activity, and then select the exact delivery acknowledgement. Required
wire fields are compared canonically; only declared transient identifiers,
timestamps, and in-flight Runtime activity snapshots may vary.

A deterministic fake Codex app-server is placed first on an isolated `PATH`
for both installed runners. The Codex-only process suite covers live model
pagination and isolated cache fallback; ordinary and fast launch;
missing-session recovery; rejected idle
and busy delivery recovery; reasoning, final-answer, command, file-change,
MCP, compaction, review, and turn boundaries; empty turns; retryable errors;
usage/rate-limit liveness; warnings; native thread errors; repeated-error
fencing; silent-turn terminal fencing; malformed/non-object live stdout
tolerance; malformed typed JSON-RPC error envelopes; numeric-equivalent
response IDs; initialize result/error precedence; and array-shaped raw-response
progress.
Together with top-level thread-status precedence, ping, reminder, and both
migration roles, 74 installed official-vs-Go Runner scenarios pass, including
reachable initialize-result Runtime-home session references,
raw-ID app-server server-request rejection,
startup thread-ready ordering, initial session identity, turn-end session
repetition, mixed-type secondary-thread
identity fencing, empty thread-started adoption, falsy repeated turn-start
steering preservation, root-only correlated-response input-evidence fencing,
exact UTF-16 diagnostic bounding, status-local native
error-reason bounding, and exact top-level fallback, generic terminal-error
message, failed/interrupted completed-turn message, array-shaped token-usage
evidence, and waiting-flag sequence preservation.

Rate-limit telemetry accepts an object or array `primary` container when a
recognized root string or finite object metric is present. It remains hidden
from immediate activity output but refreshes the launch-fenced progress
version and runtime-progress timestamp used by heartbeat and stalled recovery.

For `fileChange` item lifecycle frames, each concrete entry in a started
`changes` array contributes one tool call and one unit of turn evidence. An
empty array contributes no tool call, no stored completion count, and no
progress; its completed frame is therefore inert and cannot mask the
zero-evidence terminal path.

For `rawResponseItem/completed`, the candidate is selected in nullish order
from `item`, `responseItem`, `rawItem`, then root params. A JSON object or
array, including an empty array, contributes internal progress. Null and
scalar candidates are ignored, so malformed telemetry cannot mask the
zero-evidence terminal path.

Correlated JSON-RPC responses are consumed by their pending request owner.
App-server request/response classification uses own-field presence. An own
`id` plus a string `method` is a server request only when neither `result` nor
`error` is present. Unsupported requests receive method-specific `-32601`
with the original raw ID, including zero, empty-string, and null values. A
frame containing `result` or `error` is always a response; only a positive
integer ID can resolve a locally generated pending request. Model discovery
ignores non-response frames, even when their numeric ID equals its current
request. Persistent startup and discovery both reject initialize results whose
`userAgent` becomes empty after trimming and expose the same actionable
compatibility error.
Successful `thread/start` and `thread/resume` results are first adopted in the
reader's wire order. The normalizer announces that startup result once. A
one-shot startup scheduling window admits the immediately following
`thread/started` to the normalizer, but a different nonempty identity remains
secondary and is fenced without changing or re-announcing the current session.
Any initial `turn/start` remains addressed to the original startup-result
thread. The window is consumed by that notification or cleared at
`turn/started`.
When normalization emits `turn_end`, Agent Manager first publishes the
terminal idle/error activity, then repeats the current nonempty
`agent:session`, then publishes the runtime profile. The installed suite
asserts initial-session identity and turn-end session multiplicity at separate
explicit boundaries.
For an unclaimed successful response, a present string `result.thread.id` is
adopted before error handling and secondary-thread filtering. It produces a
session event only when this Runtime has not announced one; subsequent
notifications for the adopted thread are primary output.
For ordinary notifications, the secondary-thread fence selects the first
nonempty string from `params.threadId`, `params.thread.id`, then
`params.sessionId`. Each candidate is decoded independently: an empty or
non-string higher-priority candidate is skipped without invalidating a valid
lower-priority identity. A selected identity different from the current
nonempty thread is suppressed.
After the startup window, `thread/started` follows that ordinary fence and
then reads only nested `thread.id`. A present string is adopted even when it is
empty; absent, null, and non-string IDs are ignored. Clearing to an empty
current thread allows the next nonempty notification identity to become
primary under the same truthy official predicate.
String `result.turn.id` takes precedence over string `result.turnId` and
records a pending accepted turn. A later `turn/started` adopts it only when the
notification does not contain a string ID, then clears the pending state.
That precedence describes unclaimed successful-response normalization.
Responses consumed by a pending non-empty `turn/start`/`turn/steer` owner use
only nested string `result.turn.id` for accepted-input evidence, plus the
already-active turn ID stored by busy steering; a root-only alias is ignored.
Explicit starts and completion also clear pending state. Busy steering requires
a current turn, no pending turn, and an open tool-boundary gate.
`turn/started` distinguishes its selected notification ID from active turn
state. A nonempty explicit/pending ID replaces the active turn. A falsy
selection preserves the previous active ID for `turn/steer` and completion
memory, while still clearing pending state, resetting per-start evidence and
the steering gate, and emitting a thinking event without a fabricated turn ID.
When a response error has no remaining owner, it still passes through Runtime
normalization before secondary-thread filtering. A non-empty
`error.message` is preserved exactly; an empty message becomes
`Codex app-server request failed`. Such a response must not be silently
discarded.

## Object-store migration archive

The v2 archive is a gzip-compressed tar whose first entry is
`manifest.json`. That entry is an
`agent-object-store-tar/v2` envelope containing an inner
`agent-bundle/v1` migration manifest. The inner manifest declares each
workspace file's relative path, `workspace/` bundle path, size, mode, mtime,
and SHA-256. The source reports the SHA-256 of the canonical inner manifest,
not the outer envelope bytes.

Extraction accepts the observed official envelope while retaining the stricter
product boundary: only declared regular workspace files are restored;
traversal, duplicate entries, links, undeclared files, regenerable directories,
and sensitive credential paths are rejected. The target workspace must not
already exist. This matches the observed
`MIGRATION_WORKSPACE_ALREADY_EXISTS` safety fence and prevents migration from
overwriting unrelated local state.

The isolated source differential validates the media type, lease token,
manifest/file hashes, archive format, and `source-ready` report. The target
differential validates authenticated download, content adoption, and the
ordered `start-transfer → flip-machine → arrived` control sequence, including
arrival-report hash presence.
