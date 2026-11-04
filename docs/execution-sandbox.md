# CreateSandbox execution primitive

**@opencraft/sandbox** owns the backend-independent contract and the
createSandboxPool() / createSandbox() functions. **@opencraft/sandbox-node**
implements an optional Linux systemd backend. Host selects a backend and a
trusted policy; core does not select a backend from the operating system.
E2B or another remote provider can implement the same port without returning
Node ChildProcess, local PID, IPty, systemd unit or cgroup objects.

## Ownership, resources and lifetime

Default requested resources are **4 vCPUs and 8 GiB per sandbox**. A provider
must report the effective CPU/memory budget; a different budget is rejected and
the environment reclaimed before it is exposed. A remote provider can map the
request to an appropriate template or reject it; it must not silently ignore
requested resources. Provider capability and effective constraints are distinct
from caller preference.

The existing Host owns the pool, bounded FIFO admission and cleanup; this is not
a new application daemon. Provider preparation is lazy and single-flight; a
provider outage rejects execution requests without preventing Core startup or
unrelated RPC. Initialization cannot provision user environments. Pool capacity
is explicit. With a local backend it
limits the workload resource pool; with a remote backend it is an admission
budget for that provider/account. Remote RAM does not consume the Host's RAM
budget. Each sandbox has a stable correlation identity and execution owner,
independent of transport and backend-specific environment IDs.

A sandbox can execute multiple commands. Command completion or disconnection
does not destroy the sandbox or release its reserved capacity. Closing destroys
the environment and all its executions before capacity returns. Command handles
provide opaque IDs, output callbacks, stdin, exit outcomes and termination;
terminal-capable handles additionally provide resize. Cwd belongs to the selected
sandbox filesystem. Local workspace mounting, remote file transfer and network
policy are backend responsibilities, not implicit path equivalence.

Cancellation while queued starts no backend operation. Cancellation or Host close
during provisioning reclaims a late environment before returning its budget.
An unknown remote creation result is never replayed or treated as absent:
capacity remains reserved, and teardown refuses to claim success. Only a
backend's explicit SandboxCreationFault("not-created") permits release after
creation rejection. Failed destruction likewise retains admission capacity.
A creation error carries the correlation identity for caller-owned reconciliation.
A backend must implement the lifecycle before advertising its capability.

## Optional Linux backend

systemdSandboxBackend() requires cgroup v2, systemd 254+, systemd D-Bus access
and an existing execution UID/GID. The default requires a non-root identity;
`inheritHostIdentity: true` explicitly permits the controller's existing UID/GID
for deployments whose workspaces already depend on that identity. Root Native
permission sandbox setup also needs explicit `userNamespaceMapping: true`, which
retains only CAP_SETUID, CAP_SETGID and CAP_SETFCAP in the bounding set. This option
is resource containment and does not claim same-UID adversarial isolation. User-manager mode must use its own
UID/GID and support the requested systemd isolation settings. Workspaces must
already be accessible to that account; core credentials and root-private files
are not copied or chmodded to make provisioning succeed.

It creates transient pool and per-sandbox slices through systemd D-Bus with
limits already specified. Effective kernel CPU/memory/task limits are checked
before admission succeeds. Every command starts in a transient child unit of the
sandbox; forked descendants inherit that domain. There is no post-spawn scan
window. CPU quota is not CPU affinity or a dedicated core reservation.

Linux-specific process defaults are 4096 tasks including threads per sandbox,
16384 tasks per pool, and 65536 descriptors per process. FD limits are not an
aggregate sandbox descriptor count. Linux descriptor memory also participates
in memory accounting. Limits are Host-configurable in the Linux adapter and are
reported separately from the common CPU/memory request. MemoryHigh is 75% of
MemoryMax; swap is disabled for these resource domains. IOWeight is set, but it
is not a hard disk bandwidth limit or a guarantee across stacked devices.

Close waits for command creation, stops entire owned groups and checks cgroup
population before releasing capacity. Transient domains carry a per-backend
owner stamp; cleanup refuses to stop a different owner. Live domains left by a
Host crash require explicit inspection rather than blind takeover. Resource
containment does not claim a filesystem/network security sandbox, especially
against same-UID access to privileged management interfaces.

Payload environment values never enter launcher argv. A private 0700 directory
and 0600 environment file deliver selected values to PID1 for the restricted
unit; startup/confirmed cleanup removes it. Unconfirmed creation retains protected
files for inspection. Inherited manager variable names are filtered. Control
launchers use fixed executable paths and a separate trusted environment, so task
PATH, loader variables or DBus settings cannot affect the privileged launcher.
Arguments remain literal unless the command itself selects a shell. Errors do
not echo commands, credentials or environment values.

## Explicit rollout

Deployment assembly explicitly selects the provider and policy for engine execution.
Unconfigured Hosts retain existing behavior and do not claim sandbox containment.
A selected uninstalled provider rejects execution instead of falling back to host
execution. An E2B production adapter is not included.

The independent durable terminal owner keeps its existing process RPC and lifetime.
This integration does not route that separate Workbench terminal owner through
CreateSandbox; DSH SDK terminals are covered by the engine integration below.

## First consumer and rollout

startLocalAgentHost({ processSandbox: { policy, backend, environment } }) owns
a pool and routes its terminal process RPC through the shared primitive.
The supplied backend can be local or remote. Terminal output is retained even if
it arrives before the spawn reply. Input, resize, exit, replay and kill continue
to use existing process RPC. Pending handles are excluded from duplicate starts,
and Host close cancels pending admission. Sandbox denial never falls back to a
bare command.
Sandbox terminal requests must supply a cwd in the selected environment;
missing cwd never defaults to the Host's local home directory.

Configured sandbox terminals receive only explicitly selected Host environment
values plus caller-supplied overrides; they do not inherit the Host process's
whole environment, which could leak credentials to a remote provider.

The option is explicit. Unconfigured Hosts retain existing process behavior and
do not claim sandbox containment. The Linux backend refuses unsupported platforms.
An E2B production adapter is not included; a selected uninstalled provider rejects
execution rather than falling back to host execution.

## Engine execution integration

The deployment selects a private, owned `OPENCRAFT_SANDBOX_CONFIG` file (or the
operator-installed `/etc/opencraft/sandbox.json`). Its schema names a backend,
backend-owned options, pool capacity/defaults and an explicit environment policy.
`local-inherit` is valid only for the local Linux provider; remote providers must
select named environment entries. Codex Thread creation and each subsequent turn explicitly select the provider
environment; resumed turns resolve the real Thread cwd instead of using the
controller cwd. Native permission fields are preserved. Each engine transport uses the same
`createSandbox()` contract. Task loader variables and credentials travel in a
private input envelope, never in the controller environment or launcher argv.

| Consumer | Sandbox lifetime and protected behavior |
| --- | --- |
| Codex | The official, unmodified exec-server runs in a sandbox for its execution environment. Native permission and filesystem/network policy stay in the official executor. |
| DSH pipes | Each subprocess invocation uses a sandbox. The SDK still owns collection, timeout classification and its existing permission wrapper. |
| DSH terminals, including ACP DSH | The SDK PTY, foreground inspection and foreground signals run together inside a sandbox; a bounded private pipe transports operations and output. |
| Pi | Each conversation shell worker and all of its terminal descendants share a sandbox. Owner loss interrupts work; it does not replay it. |

Codex APP readiness requires the configured environment's live `environment/status`
response to be `ready`, after the initial `environment/info` warmup. Health and
execution admission use bounded, coalesced read-only observations; a background
observation runs every two seconds. `pending`, `disconnected`, malformed responses
and timeouts are unavailable. New Thread/fork, Turn start/steer, command
and filesystem operations reject with `Execution environment unavailable`; reads
of conversation history remain available. Observation never starts, reconnects
or recovers exec-server. External recovery can make the same APP ready again.
Router health inspects its existing APP without starting a generation. The
private authenticated `/native-health` endpoint attests only the existing Native
owner's liveness. Router routing refresh for ready/active/draining owners uses
that endpoint so history reads survive execution loss; cold/new owner admission
and deployment health still require executable `/health`. Older APPs without
the supplemental endpoint follow the existing startup observation path. Host
readiness observes control health even while its connection stays open; CLI
`status` and Server directory expose `unavailable` during execution loss.

The generation's `runtime/exec-server-lifecycle.jsonl` is a private (0600)
append-only diagnostic sink, independent of Native stderr. File writes run in
Node's asynchronous filesystem worker pool, serialize per logger, and drain on
owner/transport shutdown; connection threads perform no synchronous log IO. It records timestamps,
controller PID/parent PID, generated sandbox identity, transient unit, start/exit,
service exit code or numeric signal when observable, and launcher exit code/signal.
It distinguishes stdin EOF, output loss, cancellation, normal cleanup and APP
owner stop (including SIGTERM/SIGINT, startup or Native failure). A missing unit
status is unknown; a launcher exit is not presented as proof of the payload's
signal. External stops without an observed initiator remain unattributed.
No command, cwd, environment, protocol payload, raw error or Native stderr is
logged. A diagnostic write failure does not alter execution semantics.

These are resource owners, not a promise of one sandbox per Thread for every
engine. In particular, a Codex environment can serve multiple Threads. A future
provider's filesystem and working-directory mapping must be implemented before
claiming remote engine compatibility.

The Linux generation supervisor additionally bounds the Native execution owner
and auxiliary child processes before launch. The account Core and routing owner
stay outside that domain. Codex's standalone `command/exec` requires the official
local environment, so it is retained only after verifying the Native owner's
kernel CPU/memory/PID limits; this is bounded local execution. A non-local provider
has no automatic local fallback. Existing retained generations require a managed
deployment policy to apply equivalent limits until they retire.

The generation owner is an aggregate controller domain, not one payload sandbox.
Its optional `backend.options.executionOwner` resources are therefore independent
from `pool.capacity` and `pool.defaults`: the former bounds Native and auxiliary
processes across the generation, while the latter continue to define admission
and per-sandbox resources. Omitting `executionOwner` preserves the legacy
payload-sized owner defaults. An explicit `memoryHighBytes: null` leaves the
owner's soft limit unset; a finite configured parent slice remains mandatory and
provides the shared host ceiling. A managed deployment must reconcile already
running generation owners against this policy as well as using it for new
owners; otherwise a prior transient limit can survive a package update.

A Linux `parentSlice` must already have finite CPU, memory and task limits. It
provides a shared kernel ceiling across independent engine controllers; a
per-process pool must not be described as global admission accounting. Optional
`ownerUnit` binding stops payloads when the verified execution owner stops. SSH,
Core priorities, old-generation limits and host headroom belong to deployment
policy. External SSH commands, browsers and unrelated processes are not made
sandbox consumers by this integration.

~~~ts
const pool = await createSandboxPool({
  id: "host-tools",
  capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 },
}, selectedBackend);
const sandbox = await createSandbox(pool, { owner: executionId });
try {
  const command = await sandbox.spawn({
    command: ["git", "status"], cwd: "/workspace", env: {},
  }, output => consume(output));
  await command.exited;
  // More commands can run in the same environment.
} finally {
  await sandbox.close();
}
await pool.close();
~~~

## Acceptance

Contract tests cover remote handles, multiple commands, unsupported terminals,
effective budget mismatches, cancellation, late provisioning, unknown creation,
failed destruction and bounded admission. Host terminal tests check denial,
pending close and remote output/input/resize without leaking Host environment.

The explicit Linux smoke creates a unique synthetic domain and verifies actual
4 CPU / 8 GiB limits, PID/FD limits, inherited fork membership, multiple commands,
descendant cleanup and capacity reuse. It runs no exhaustion workload and never
targets existing service units. Use a Linux test host and
OPENCRAFT_SANDBOX_SMOKE=1 node --import tsx scripts/smoke/execution/smoke-sandbox.ts
as a manager-authorized operator. No deployment changes follow from adding this
source.

Engine command envelopes are bounded in-memory control frames sent through the
controller stdin before payload stdin. Framing preserves binary bytes following
the header, including bytes in the same read; EOF, malformed/oversized headers
and cancellation fail closed. Loader values and credentials stay outside the
controller argv/environment. Preparation, parsing and cleanup perform no
synchronous filesystem operations on an engine dispatch thread.
