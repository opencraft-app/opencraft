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

The trusted generation config uses `permission: "allow-once"` when the Host
should automatically approve native ACP permission requests and expose its Full
access profile. The default rejects those requests and cannot prepare a child
that requires Full access. DSH native policy is configured independently through
its explicit generation environment and profile; the adapter does not broaden a
restricted source delegation.

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
