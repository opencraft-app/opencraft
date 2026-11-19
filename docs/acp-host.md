# Independent ACP and Claude Host

`execution/acp-host.mjs` is a separately installed, pinned execution owner. It
adapts an installed ACP agent, a DSH ACP profile or a Claude Agent SDK ACP bridge
to the same driver contract. A gateway attaches through the private descriptor;
restarting the gateway leaves the Host, native pipes, running turns and MCP tool
endpoint alive. The package includes `opencraft-acp-host.service` as an optional
installation template. Startup does not install packages or services.

Set `OPENCRAFT_ACP_HOST_CONFIG` to an owned `0600` JSON file:

```json
{
  "id": "claude-code",
  "descriptorPath": "/run/opencraft-claude/host.json",
  "dataDirectory": "/var/lib/opencraft/claude-host",
  "runtimeDirectory": "/srv/opencraft",
  "machineIdentityDirectory": "/var/lib/opencraft",
  "sessionCapabilitiesDirectory": "/var/lib/opencraft",
  "initialGeneration": {
    "id": "sdk-1",
    "configPath": "/etc/opencraft/claude-sdk-1.json"
  }
}
```

The generation config names the installed ACP command, absolute workspace and
optional environment overrides. For Claude Code, use a pinned installation of
`@agentclientprotocol/claude-agent-acp`, an ACP bridge over the Claude Agent SDK.
A plain Claude CLI is not an ACP peer. Credentials stay in private external
configuration; generation registry files record config paths and an integrity digest, never
credential values.

For DSH, select `id: "dsh-acp"` and name `dshEntry` in its generation config.
The entry must actually support `--profile acp`; the older bundled DSH web
runtime is not silently upgraded or replaced. Optional `patches` are exact local
DSH profile overlays. Every generation receives its own native `DSH_HOME` under
`dataDirectory/native/<generation>`. Native history uses that runtime's public
read-only persistence API, its own format validation and the shared disposable
transcript cache. The default native root is `DSH_HOME/sessions` with `zstd`
encoding; configurations that override the native persistence root or encoding
must also declare `nativeHistoryRoot` / `nativeHistoryCompression`.

The independent Pi/multi-engine Host can attach with:

```json
{
  "remoteEngines": [
    { "id": "claude-code", "descriptorPath": "/run/opencraft-claude/host.json", "dataDirectory": "/var/lib/opencraft/claude-host" },
    { "id": "dsh-acp", "descriptorPath": "/run/opencraft-dsh-acp/host.json", "dataDirectory": "/var/lib/opencraft/dsh-acp-host" }
  ]
}
```

Use thread prefixes `claude_`, `dsh_acp_` and `acp_`. The old DSH web owner and its
existing thread namespace remain separately attached. Driver `dsh` can select
the new ACP provider while existing web threads retain their old owner.

The private authenticated `/generations` endpoint accepts `add`, `activate`,
`suspend` and `retire`, with an optional `expectedCurrent` comparison. Activating
a generation moves only new admissions. Existing threads and durable preparation
tickets keep their original generation. `suspend` applies to a noncurrent,
drained generation: active turns, admissions, callbacks, unacknowledged creations,
preparation tickets and uncertain inputs must all be zero. The peer must
advertise native Resume support. Its process then exits and the registry records
`dormant`; historical bindings remain available without starting an engine.
Explicit Resume or a new accepted input lazily reopens the original generation
and native session id, preserving the current generation. Dormancy survives Host
restarts, and changed fixed command/options are refused rather than silently
adopted. `retire` additionally requires no historical bindings. A gateway update
does not use this endpoint or stop any execution Host; no reclamation service or
timer is installed.

The Host exposes only implemented capabilities. ACP peers without a supplied
native reader do not advertise history replay. Fork, deletion, images and
reasoning selection are not advertised by this adapter. Claude bridge session creation and model execution are
separate checks; a successful ACP handshake alone does not prove model access.

## Queued follow-ups

The ACP execution owner also holds pending messages, including connected Codex,
Cursor, Claude, CodeBuddy and Pi CLI sessions. It advertises queue support and
editable/reorderable custody, while native steering remains unavailable. The
Composer uses the queue when the selected Agent cannot steer, even if the user's
preferred follow-up mode is immediate. A nonempty draft exposes Queue and a
separate Stop action; stopping keeps that draft.

Queue entries, inline image bytes, additional context, admission fingerprints
and execution receipts use the session's existing asynchronous atomic file owner.
Acceptance follows the committed write. One per-thread dispatcher admits the
next message after successful completion, independently of the viewing client.
Stop pauses custody before cancelling; provider failure and archive also pause
pending input. Editing, removal, exact reordering and explicit resume use the
same serialized owner. A new successful direct input resumes normal dispatch.

On restart, reading history or queue state never starts the Agent. Remaining
custody is paused for explicit resume. An attempted claim is reconciled against
the stable client identity committed with the Turn before native prompt bytes
are sent. A committed Turn retires custody; a claim without that commit remains
editable and can resume. Unconfirmed native operations still block execution.
Admission tombstones prevent deleted or already-delivered input from replaying
after a lost ACK. Pending custody contributes to generation occupancy and prevents
suspending or retiring that owner.

`tests/execution/acp-queue.test.ts` covers FIFO, screenshots, client disconnect,
Stop/failure, edits/removal/reordering, admission replay and restart boundaries.
`npm run smoke:acp-follow-up` mounts the actual Workbench route against an isolated
RPC Host and ACP stdio peer, exercising desktop and touch queue submissions and
automatic completion. The external Agent and its history reader are controlled
fixtures; this does not claim paid model access or an upgraded remote machine.

`permission: "allow-once"` controls native ACP permission callbacks. It does not
select an Agent's execution mode. DSH native policy remains independently
configured through its explicit generation environment and profile.

For native Codex ACP, the adapter discovers the peer's offered `mode` config and
binds `read-only`, `workspace-write`, `agent` and `agent-full-access` to Read only,
Accept edits, Auto review and Full access respectively. Full access is applied
with `session/set_config_option` and must be returned as the current value before
any input is sent. Empty, rejected or mismatched replies block input; the adapter
never fabricates a successful mode from callback approval. Native custom profiles
retain their identity and label without an inferred built-in policy.

The selected mode is durable intent, separately from the current native
observation. Resume reapplies and verifies that intent before sending or draining
queued follow-ups. Cold history reads remain cold and do not claim the saved mode
is currently active. Confirmed settings update the live conversation projection;
read observations are presentation only, never execution activation.

`opencraft/scoped-permission-catalog` routes permission discovery by immutable
thread owner, or by the selected draft model. Connected Agent creation preserves
the requested profile rather than replacing it with Full access. Other Agents do
not receive a different engine's selectable profiles. Old Hosts retain their wire
shape; a multi-engine Host without this extension offers no shared permission
picker. `npm run smoke:acp-permissions` covers the real Workbench/RPC/stdio path in
desktop and touch contexts with a controlled peer; native execution needs separate
installed-Codex verification.

## Explicit native model discovery

Codex and Cursor ACP declare `opencraft/model-catalog-refresh`. The Host negotiates
`opencraft/scoped-model-refresh` and routes `opencraft/models/refresh` by immutable
conversation owner, or by the selected draft model. Both Composer menus offer
Refresh models only for an Agent declaring this capability. Refresh keeps the
open menu, search, draft and selected model; failures retain the last successful
list and allow retry.

The adapter creates an archived discovery session in the same Agent source/home
and workspace. This requests a fresh native model list without resuming,
reconfiguring, interrupting or prompting the user's session. The last successful
snapshot has one persisted owner; incomplete probes and older saved sessions
cannot reintroduce removed entries. Normal model reads stay cold after restart.
Cursor discovery uses its own process and reaps that process after success or
failure. The active conversation's process, current model and parameters remain
untouched. The explicit request has a separate three-minute discovery budget;
ordinary catalog reads retain their existing timeout. Older Cursor versions may
need to inspect each offered model's schema before discovery completes. A freshly advertised Cursor model can be selected through the native
configuration setter only after its returned configuration confirms the choice.
A newly discovered Codex model can be selected in an existing conversation via
the native model setter, with an observed configuration acknowledgement required
before input. No model ID or reasoning capability is invented from a label.

Cold history model captions normalize Codex's transport prefix and known effort
suffix for presentation only. The native model value remains intact; reasoning
appears in its existing separate status slot. Scoped `model/list` is a read,
requires no execution activation, and retains the native Agent identity.

`npm run smoke:native-model-refresh` covers the real Workbench/RPC/stdio path
with a controlled native peer, including new model discovery and its subsequent
use. `smoke-model-browser` covers pending/error/retry, preserved choices and draft,
late metadata, keyboard/touch and themes. Set `OPENCRAFT_REFRESH_AGENT=cursor` to exercise the same real Workbench path for Cursor. Installed native refresh is a
separate verification; model availability still follows the Agent's own account,
provider and model listing.

## Prepared default activation

Generation snapshots expose `ownerIncarnation`, `admissionEpoch`, provider
incarnation and historical binding counts. `preparation` returns an opaque
receipt bound to that owner, native PID, configuration digest, current default
and admission epoch; it expires after one minute. Upgrade activation supplies
`expectedCurrent`, `expectedEpoch`, `expectedOwner`, `operationId` and
`preparation`. Preparation also checks the expected owner; activation persists
the operation receipt together with the default. The epoch also rejects an
ABA default change. Host restart or native replacement invalidates old receipts.
The private endpoint accepts these fields; it does not add a public model route.

ACP still has no discard. Candidate cleanup uses existing occupancy guards:
`retire` requires no active work and no historical binding; otherwise only an
idle resumable generation may `suspend` into `dormant`. The upgrade journal
records this disposition. A dormant binding resumes in its original generation.
Registry publication fsyncs the file and parent directory; persistence failure
stops admission instead of continuing from an uncertain in-memory default.

See [generation upgrade transactions](full-upgrade-generations.md).


## Host process handoff (protocol 1)

The private authenticated `POST /owner-handoff` endpoint accepts `fence`,
`inspect`, `release`, `cold-ready` and `resume`. Mutations require exact
`expectedOwner`, `expectedEpoch`, `operationId` and `fence`; resume additionally
requires the identity returned by cold readiness. The durable
`host-handoff.json` authority wraps the complete Host dispatcher, including
filesystem/project resources, and closes all execution RPCs, private inputs and
generation management before reporting a fence. Existing native Turns and
callbacks continue; input receipt queries and orchestration acknowledgements
may reconcile accepted work while draining. Release seals those remaining lanes.

Occupancy includes Host calls, native admissions, pending creations, preparation
tickets, uncertain inputs/Turns, native transport requests/callbacks and storage
failures. A timed out native request remains unknown, even if a late response
arrives, and a child exit with pending requests persists an uncertainty ledger. Historical bindings are counted separately and retained. This ACP
adapter has no independent goal, queue or schedule executor; their callers
cannot bypass its Host admission authority. Read failure is never an empty proof.

Release requires complete zero occupancy, stops all native generation processes
with Resume support, and flushes registry persistence. The old Host still holds
its kernel writer lock until fully closed. A successor acquires the same
`acp-writer.lock` before loading any store, also respecting the legacy owner
lock during migration. It requires the old durable release, cold reads current
registry/catalog/receipts and initializes the pinned native peers. It remains
fenced until its own cold readiness is explicitly consumed. Resume rechecks
zero occupancy, OS/storage authority, native identity and the exact readiness
proof; retained bindings require native Resume support. Dormant generations
with unproven Resume capability remain blocked. Unknown old release,
persistence failure, changed owner/epoch or dead native readiness fails closed.
No data snapshot is restored and no native input is replayed by this protocol.

Legacy Hosts without this endpoint require a separately identified bootstrap
maintenance; they are not protocol-1 starting points. The protocol does not
install/enable an engine, migrate a schema, authorize a full release recipe or
provide generic automatic rollback across incompatible data. Native descendant
processes outside the ACP transport require deployment cgroup supervision and
an explicit compatible recipe; unsupported peers remain blocked.
