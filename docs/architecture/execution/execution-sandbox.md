# CreateSandbox execution primitive

**@opencraft/sandbox** owns the backend-independent contract and the
createSandboxPool() / createSandbox() functions. **@opencraft/sandbox-node**
implements an optional Linux systemd backend. Host selects a backend and a
trusted policy; core does not select a backend from the operating system.
E2B or another remote provider can implement the same port without returning
Node ChildProcess, local PID, IPty, systemd unit or cgroup objects.

## Ownership, resources and lifetime

The durable Assets admission layer and its incomplete default-workspace wiring
are described in [Assets workspaces and budgets](workspace-assets.md).

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

## Stated guarantees

Each environment states what its provider guarantees: `resources` is `enforced`
(the reported CPU/memory limits applied before user code ran) or `unenforced`
(they are an admission reservation only), and `containment` is `complete`
(close reclaims every descendant, even one that leaves its group or session) or
`best-effort`. An environment that states nothing claims the full guarantee
this contract has always required; the Linux systemd, Hands and E2B providers
keep that claim. A provider that guarantees less must say so.

A pool admits a weaker environment only when its policy explicitly accepts that
dimension (`accept.unenforcedResources`, `accept.bestEffortContainment`);
otherwise the environment is reclaimed and creation fails with
`SANDBOX_POLICY`. Every admitted `Sandbox` exposes its resolved `enforcement`,
so a consumer never presents a weaker environment as isolated. An unenforced
environment still reports the requested budget, which keeps admission counting.
Wrappers that forward an environment must forward its statement as well.

## Host-process backend

`hostProcessSandboxBackend()` (`host-process`) runs each command as an ordinary
host process for hosts without a kernel resource domain: macOS, Windows, or
Linux without systemd. It states `unenforced` resources and `best-effort`
containment, and a runtime configuration that selects it must accept both
explicitly. Permission isolation stays with the engine, for example Codex's own
native sandbox; this backend adds lifetime ownership, not isolation.

- POSIX: each command starts its own session and process group. Close, and the
  end of the command's root process, ask the group to stop, force it after the
  grace period and confirm the group is empty before capacity returns. A
  descendant that starts its own session leaves the group and can survive.
- Windows: the root's live tree is stopped with `taskkill /T`. A descendant
  whose parent already exited is no longer in that tree and can survive.
- Commands receive exactly the selected environment and an absolute cwd on the
  host filesystem. Terminals use a pseudo-terminal.
- A private state directory records the owner and each command's PID with its
  start identity before the caller receives the process. A successor owner
  refuses while the recorded owner is still alive, and otherwise reclaims only
  groups it can identify as its own: the same leader by start identity or, on
  POSIX, a leaderless group still carrying the recorded number (a PID is not
  reused while it names a live group). Anything it cannot reclaim stops
  initialization for inspection.

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
execution. An optional `@opencraft/sandbox-e2b` execution adapter is included; it is not
registered in engine assembly, and Bot/workspace assembly registers it only
through the provider registry described below. Its transport, resource and
lifetime scope is documented in [the E2B adapter](../../../packages/sandbox-e2b/README.md).
Provider tests must not be described as complete production Bot integration.

### Provider registry, shared broker and persistent workspaces

Remote providers are pluggable without touching workspace or Bot owners. E2B,
`static-docker` (WorkspaceHost placement) and `cloudflare`
(`@opencraft/sandbox-cloudflare`, a container held by the WorkspaceHost Durable Object;
no deployment assembly yet) are implemented; no other provider exists, and a registry
entry alone is not a claim of
compatibility.

- **Registry.** `@opencraft/sandbox/providers` defines a provider as
  `{ id, createBackend(request) → SandboxBackend, persistentWorkspaces? }`.
  Deployment assembly (`apps/headless-server/src/sandbox-providers.ts` in the
  Assets Worker; `apps/opencraft-daemon/src/assistant-environments.ts`) registers
  providers explicitly. Consumers resolve by the installation's configured
  `backend`; an unknown or unregistered ID fails closed with
  `SANDBOX_UNAVAILABLE`, never falling back to local execution or E2B. Provider
  IDs are at most 23 characters so the per-provider pool ID stays valid. The
  headless Worker reports its registered IDs (`botBackends`) to Main, which keys
  Bot environment providers by them.
- **Request.** `createBackend` receives the secret-free provider-typed
  installation, an installation-owned `readSecret()`, template, interpreter,
  timeouts, and optional workspace binding, creation receipt and bounded lease
  callbacks. Credentials and endpoints never come from Bot or task input.
- **Shared broker.** `@opencraft/sandbox/broker` owns the Python NDJSON broker
  program and the host-side framing and process state machine: `start`, `stdin`,
  `resize`, `eof` and `terminate` frames to the broker; `started`, `output`, `exit`
  and `error` frames back; base64 payloads; 400000-byte broker lines; one PTY output
  stream; process-group SIGKILL; no reconnect or replay after transport loss; for
  ordinary processes transport loss or an unacknowledged termination retires the
  environment. `attached` processes are the exception described below; the flag
  is Host-side lifetime and is never sent to the broker. It has no Node, vendor SDK
  or E2B types. A provider supplies only a launch port that starts
  `python3 -u <broker>` and returns `{ write(frame), ended }` plus stdout text
  chunks. E2B keeps only the upload (`files.write`) and launch
  (`commands.run(..., stdin)`) calls; fault codes and messages are unchanged.
- **Persistent workspaces.** The optional `PersistentWorkspaceProvider`
  capability supplies `receipt()` (sole instance member plus stable private volume
  ID after create), `inspect(binding)` (`absent`/`present`/`unknown`, never an
  allocation lock) and `verifyMounts(environment)` (never mounts). The ordinary
  allocator and Bot owner require it whenever the installation enables persistent
  workspaces; a provider without it cannot be selected. E2B's implementation keeps
  its existing schemaVersion 2 workspace/volume API calls and NFS `/workspace` and
  `/shared` rules.
- **Configuration compatibility.** Installation files and vault credentials are
  provider-typed by a `backend` discriminant; the E2B variant keeps its fields.
  A schemaVersion 1 installation file or version-1 vault credential without
  `backend` is E2B. E2B credentials are still stored without `backend`, so existing
  documents are rewritten only by existing write paths and in the same shape.
  Workspace configuration revisions keep the E2B endpoint facts in their original
  positions, so persisted selections stay valid. Resource checks, unknown-creation
  retention, confirmed destruction, lease renewal and error codes are unchanged.

### Endpoints and attached processes

`SandboxCommand.attached: true` (pipe processes only; `createSandbox` rejects it
with a terminal) marks a connection-scoped relay. Its transport loss, startup
failure or unacknowledged termination ends only that process: `exited` rejects,
`terminate()` rejects with `SANDBOX_CLEANUP`, and the environment and its other
processes stay alive. Environment close still reclaims it; capacity rules are
unchanged. Without the flag a backend that cannot account for a lost process
retires the environment as before.

`openSandboxEndpoint(environment, { target: { unix }, onData })`
(`@opencraft/sandbox/endpoint`, no Node types) is the provider-neutral byte
connection to a stream socket inside an environment: one attached process running
a fixed Python relay per connection, with `write` (resolves when the provider
accepted the bytes), `end` (half-close), idempotent `close` and a `closed` outcome
(`ended`/`failed`). There is no reconnect or replay. The process contract has no
output flow control, so consumers must bound undrained output.
`createSandboxEndpointListener` (`@opencraft/sandbox-node/endpoint-listener`)
exposes an endpoint as a Unix socket in a private 0700 directory for clients that
dial a path; it authorizes each connection, back-pressures local input on the
provider, closes a connection whose undrained output exceeds its bound, and
reports unconfirmed relay cleanup. The browser owner attachment uses the endpoint.
A target is either a name from `SANDBOX_ENDPOINT_NAMES`, resolved only as
`<endpointDirectory>/<name>` (default `SANDBOX_ENDPOINT_DIRECTORY`, an image property
where the in-environment `workspace-agent` publishes its allow-listed endpoints), or a
caller-validated `{ unix }` path kept for owners not yet supervised by that agent.
Unknown names, mixed targets and relative directories are refused before any spawn.

The sandbox file port (`SandboxWorkspaceFiles`) uses one attached resident helper per
binding instead of a process per operation: requests are id-tagged JSON lines over
that one process stream, answered concurrently and written whole. Losing the helper
fails only its in-flight requests (never resent); the next request starts a new one.
Every backend that advertises endpoints must pass
`tests/execution/sandbox-endpoint-conformance.test.ts` (binary round trip,
half-close, close from either side, back-pressure, attached failure isolation and
validation, receipt re-attach, `workspace://` resolution); the suite runs
in-process, local child-process, E2B adapter (vendor SDK replaced by local
processes), static-docker link (agent link server in-process) and Cloudflare (the real
backend over an in-process `ctx.container` double, tests/execution/fixtures/cloudflare-container.ts)
harnesses, plus
opt-in real-container harnesses: `docker exec` + broker
(`OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER=<image with python3>`) and static-docker
(`OPENCRAFT_SANDBOX_CONFORMANCE_STATIC_DOCKER=<opencraft runtime image>`, the image's
`workspace-agent --bare` as container main process) and docker-provisioner
(`OPENCRAFT_SANDBOX_CONFORMANCE_DOCKER_PROVISIONER=<opencraft runtime image>`: the
provisioner service in-process with the Docker socket, the backend under test without it). Placement use and measurements
are in [workspace-host-split](../platform/workspace-host-split.md).

### Workspace addresses, receipts and re-attach

Addresses are URIs only at configuration and client boundaries
(`@opencraft/sandbox/uri`); they are parsed into typed values and never carry
credentials, ports, queries or fragments:

- `workspace://<workspaceId>/endpoints/<name>` — an endpoint a workspace's agent
  publishes (`name` ∈ `SANDBOX_ENDPOINT_NAMES`). Clients hold only this.
- `<provider>://<target>` — where an environment runs; the scheme is a registered
  provider id and the target is that provider's selector: `static-docker://<service>`,
  `e2b://<template>`, `docker-provisioner://<image alias>` and later
  `cloudflare://<container-class>`. `SandboxProviderRegistry.environment(installation,
  address)` refuses a URI whose provider is not the installation's or whose target the
  provider's `acceptsTarget` rejects. Schemes already used elsewhere (`unix`, `stdio`,
  `ws`, `http(s)`, `workspace`, `human`, `session`, `opencraft`, …) are reserved.

A backend may set `SandboxEnvironment.receipt` (`{backend, instanceId}`, secret-free)
and implement `attach(identity, receipt, resources, signal)`; `SandboxPool.attachSandbox`
admits it like `create`. Attach never creates or replaces: when the provider cannot
prove the receipt names the same live instance it rejects `SANDBOX_UNAVAILABLE`, and the
owner decides whether to create a new environment and recover.

A backend may also set `SandboxEnvironment.lost` (optional `Promise<SandboxLoss>`,
`{reason: "exited" | "crashed" | "stopped", code?}`): it settles once, never rejects,
and only when the provider observed the environment end without the owner's `close()`
(Cloudflare `monitor()`; a later Docker provisioner's container exit). The pool passes it
through; `WorkspaceRuntime` drops the binding at once (`released` with reason
`lost:<reason>`) so the next use re-attaches or creates. The owner still calls `close()`
to confirm destruction and return capacity. Backends without it (static-docker, E2B)
are unchanged. A broker launch port may implement the optional
`SandboxBrokerChannel.dispose()`; the shared broker calls it once when a process failed
so the provider can end that transport (the Cloudflare backend closes exec stdin, then
signals only an exec that has not exited).

`createWorkspaceRuntime` (`@opencraft/sandbox/workspace`, no Node types) owns one
workspace's environment bindings: per environment it re-attaches the persisted receipt
or creates, reads the agent's identity over the `control` endpoint (`probe`:
incarnation, roles, published names; `describe`: an endpoint's credentials and engine
descriptor), persists `{receipt, agentIncarnation}` through a WorkspaceHost store
before use, resolves an endpoint name to the first environment whose agent publishes
it, and rebinds once when a relay cannot start (stale binding). `observe()` re-probes
and reports a changed incarnation. It never replays bytes.
`fenced(endpoint, operation)` runs one owner read (an execution-identity report) and
returns it only when the agent's `control` probe before and after both name the bound
incarnation; otherwise it releases the binding (the next use rebinds and persists the
new incarnation) and rejects `SANDBOX_UNAVAILABLE`. Execution leases therefore depend
only on what the agent and the owner report over the provider's channel; no consumer
shares the environment's PID namespace or reads its `/proc` (the endpoint conformance
suite runs this for every harness).

| Provider | Process channel | `receipt.instanceId` | `attach` |
| --- | --- | --- | --- |
| `static-docker` (`@opencraft/sandbox-node/static-docker`) | the agent's link: a Unix socket in a directory mounted only into the Host and that container; per process one connection carrying the shared broker | agent incarnation | same incarnation only (link `attach` with expected incarnation) |
| `docker-provisioner` (`@opencraft/sandbox-node/docker-provisioner`) | the same link as `static-docker` (`bindSandboxLink`), in the workspace's directory of a links volume the provisioner mounts into that container alone | `<container id>:<agent incarnation>` | provisioner `inspect` reports the same container running, then link `attach` with the expected incarnation; a stopped container is never started by `attach` |
| `e2b` | `commands.run` + shared broker | sandbox id | `Sandbox.connect` (pinned SDK 2.x); missing/unverifiable → lost |
| `cloudflare` (`@opencraft/sandbox-cloudflare`) | one `ctx.container.exec` per process carrying the shared broker (exec stdin is the control input) | `<incarnation label>.<kernel boot id>.<placement id>` | container running with the same `inspect()` label, boot id and placement id; otherwise lost. Never the Durable Object name |
| in-process / local process (tests, Hands-style owners) | direct | none | not offered |

static-docker link protocol (one JSON line per connection): `attach {ticket,
incarnation?}` — the ticket is written by the agent to `<link>/ticket` (0600) after it
listens and rotated after every successful attach (one-time); a newer attach revokes the
previous session and kills its processes. `open {session}` then carries one broker
process; the agent checks the broker `start` frame against its policy: `relay-only`
(default) admits only the fixed endpoint relay to an allow-listed name under its
endpoint directory, `any` is for bare/dev images and conformance. A refused or
unstartable broker answers with a broker `error` frame whose `reason` comes from a fixed
vocabulary (`policy`, `broker-unavailable`, `start-failed`); the Host carries it as the
`SANDBOX_START` fault's `cause`. The broker interpreter (`OPENCRAFT_AGENT_PYTHON`,
default `/usr/bin/python3`) is an image requirement of every container that runs an
agent: an agent whose interpreter is not executable fails its start instead of serving a
link that refuses every process. `release {session}` closes. The effective budget is the container's cgroup limit as the agent reads it; the
backend refuses a binding whose enforced limits differ from the requested budget.
A newer attach revokes the previous session by ending each broker's control input:
the broker then kills its process's own session (processes run in a new session, so
killing only the broker would orphan them); SIGKILL of the broker is a fallback.

docker-provisioner (workspace-host-split step 7b). The **provisioner service**
(`@opencraft/sandbox-node/docker-provisioner-service`, Compose overlay
`deploy/docker/compose.workspaces.yaml`) is the only holder of the Docker socket; the
Host never is. Protocol 1 over a private Unix socket in a control directory shared only
with the Host: one JSON line `{protocol, op, workspace, image?, nonce, issuedAt, mac}` →
one answer `{ok, container: {id, state, image}}` or `{ok: false, code, message}`. `op` ∈
`ensure` (create, or start a stopped container, from an allow-listed image alias),
`inspect`, `stop`, `destroy`; `mac` = HMAC-SHA256 over the canonical fields with a
request key the service writes (0600) at each start; requests outside ±30 s or with a
seen nonce are refused; unknown fields, workspace ids or aliases are refused before
Docker is called; every request, accepted or refused, is one audit log line (never the
mac or nonce). Image reference, command, user, CPU/memory/pids budget, volume, mounts
and network come only from the service's validated policy: no caller-supplied Docker
parameter exists; root users need explicit consent; mounts of Docker/containerd sockets,
`/`, `/proc`, `/sys`, `/dev`, `/etc`, `/run` and over the agent's link or run directory
are refused; images are never pulled. Created objects carry the deployment label and the
service touches no object without it. Containers run with `CapDrop ALL`,
`no-new-privileges`, `init`, the budget as cgroup limits (the agent's read limits must
equal the Host's request), a private bridge network with inter-container traffic
disabled (or none), one named volume (a cache; Git is the content truth) and their
link subpath. Optional backend capabilities used here: `sleep(environment)` (end the
Host session, `docker stop`, volume kept; waking is `create` = start the same container,
a new incarnation) and `discard(identity, receipt)` (remove container, volume and link
directory); `Sandbox.sleep()`, `SandboxPool.discardSandbox()` and
`WorkspaceRuntime.sleep()`/`discard()` expose them provider-neutrally; a provider
without them stays resident and cannot be discarded. The `cloudflare` backend also implements `sleep`: a
stopped Cloudflare container keeps no disk, so sleeping is the confirmed destruction `close()` performs and
waking is a `create` (a new incarnation); the WorkspaceHost Durable Object drives it from its idle policy
([cloudflare-deployment §5.7](../platform/cloudflare-deployment.md#57-workspacehost-状态)). Environment `close()` ends only
the Host's link session (the container stays for a re-attach), like `static-docker`.

### Provider lifecycle obligations (from the Cloudflare Containers probe)

A backend whose provider can host several incarnations under one name, stop an
environment on its own, or lose a process handle must still fit this contract. The
obligations come from a real Cloudflare Containers probe (2026-11-23; measured facts
are in [workspace-host-split §3.6](../platform/workspace-host-split.md#36-部署形态统一建模)),
but each one applies to every provider. Status after step 7a (the `cloudflare` provider):

| Obligation | Status |
| --- | --- |
| `receipt.instanceId` is the agent incarnation (or a provider id that changes whenever the instance restarts), never a reusable name such as a Durable Object or container name (one DO name hosts several incarnations over time) | static-docker: incarnation (implemented); docker-provisioner: container id plus incarnation (implemented); E2B: sandbox id plus incarnation comparison in `WorkspaceRuntime` (implemented); Cloudflare: start label + boot id + placement id (implemented; verified across a real Durable Object reset) |
| Process transport has real backpressure and half-close (`exec` stdin/stdout or raw TCP); WebSocket without backpressure is not an endpoint transport | contract and conformance suite (implemented). Cloudflare probe: `ctx.container.exec` stdin back-pressures and the fixed relay round-trips bytes; raw TCP `getTcpPort().connect()` has backpressure and half-close; WebSocket upgrade has none. `sandbox-cloudflare` uses exec + broker + relay (conformance suite with the double; 4 MiB round trip on real Cloudflare) |
| A lost process handle must not leave orphans: every broker process runs in its own session and the broker kills that session on control-input EOF; `workspace-agent` stops every child when it stops | implemented (broker `setsid`/`killpg` on EOF, link revocation by EOF; the AppServer child is a `detached` group signalled as a group, other children are signalled directly and are expected to own their descendants). Cloudflare: every exec is a broker that reads its control input, so a handle lost in a DO reset EOFs it and it kills its session (implemented). Follow-up: `workspace-agent` reaping its own children when a link/endpoint connection ends |
| Termination of an already exited process is not a cleanup failure and never signals a reused PID | Cloudflare backend: an exec is signalled only while its `exitCode` is unsettled (signalling an exited exec is an internal error in the DO); broker-side PID reuse check before `killpg`: follow-up |
| The container main process handles SIGTERM | implemented: `container-service.mjs` forwards SIGTERM/SIGINT to `workspace-agent`, which drains and stops its children (the probe container without a handler did not stop for 30 s) |
| Environment loss reported by the provider (crash without restart, provider-initiated stop, idle backstop) | implemented: optional `SandboxEnvironment.lost`; Cloudflare drives it from `monitor()` (verified on real Cloudflare: agent stop → `exited` in ~140 ms, runtime released and re-created). Docker container exit: follow-up (`docker-provisioner` does not yet subscribe to Docker events) |
| Native endpoint connection (`connectEndpoint(target)`, for example a container TCP port with the agent routing each connection by its first line to the endpoint socket) preferred over the relay | follow-up, optional (not in the contract yet; the Cloudflare backend uses the relay): same semantics as the relay (backpressure, half-close, no replay); the relay stays the fallback |
| Provider idle timers are re-armed by the owner | Cloudflare: set after start, on attach and on backend initialization; `armCloudflareContainerTimeout` for the DO constructor (implemented; the WorkspaceHost object calls it on every construction). Only a backstop for the WorkspaceHost idle policy |
| Resource limits the provider does not enforce | Cloudflare containers report `cpu.max`/`pids.max` as `max` and nofile 1048576: the default 4096 tasks and 65536 FD per process must be applied by `workspace-agent`; CPU and memory (custom 4 vCPU / 8 GiB accepted) are reported by the provider |

### Optional persistence and sleep capabilities (`sleep`/`discard` implemented for docker-provisioner; snapshots design)

The workspace content's durable source of truth is Git; a sandbox (disk, volume,
engine-private data) is a rebuildable cache for every provider. A provider may
declare an optional `snapshot` capability — `retained` (sleep/stop keeps the disk:
Docker volume, E2B pause) or `captured` (explicit `captureSnapshot` /
`restoreSnapshot`: Cloudflare `snapshotContainer`, 30-day TTL, not deletable from the
Worker API) — and an optional `sleep(environment)` (implemented as
`SandboxBackend.sleep?`, with `discard?`; see docker-provisioner above; the `snapshot`
declaration is not). Both only speed up recovery and
lower the chance of losing uncommitted changes; a provider without them is still
correct, and no provider's beta feature is relied upon. A restored snapshot is always
a new instance (new receipt, new incarnation) and never a reason to replay
unconfirmed input. When the owner requests capture, how it reconciles a restore with
Git, and the WorkspaceHost-owned idle policy (default sleep after 15 minutes, optional
resident) are specified in
[workspace-host-split §3.7](../platform/workspace-host-split.md#37-工作区持久化与空闲设计2026-11-23-用户决定未实现).
The existing `PersistentWorkspaceProvider` for Assets workspaces is unchanged.

The independent durable terminal owner keeps its existing process RPC and lifetime.
This integration does not route that separate Workbench terminal owner through
CreateSandbox; DSH SDK terminals are covered by the engine integration below.

## Engine execution integration

Remote conversation bindings consume the preinstalled Hands Codex launcher at
`/opt/opencraft/runtime/codex/bin/codex`; image/package/template builds own tool
delivery. Runner startup does not download tools, extract shared archives or
repair missing runtimes. Existing templates without this layout must be upgraded
before selecting this runner version. A missing executable fails through the
existing authorized process bridge without a host fallback. Process transport,
per-session state, live authorization and cleanup retain their existing owners.
See [Hands templates](../../hands-e2b-templates.md) for operator preparation.


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

The three-container Docker assembly selects the `hands-unix` backend for Codex.
Workspace files also belong to Hands. The Gateway's local Host `fs/readDirectory`,
`fs/getMetadata`, `fs/readFile`, `fs/writeFile` and `fs/createDirectory` requests
use the private authenticated Hands filesystem owner, independently of the engine.
Raw AppServer and leased AppHost ingress apply the same current human/instance
authority. SSH Hosts keep their existing remote route. Preview and download bytes
use that same owner through a streaming data plane, with cancellation and access
revocation; file bodies need not occupy the chat WebSocket. The owner bounds IO
concurrency to four operations, queues up to 64 additional requests, and serializes
writes to the same resolved path. Unsupported file operations and owner loss do
not fall back to Brain's filesystem. This preserves `include_local = false` for
the Native execution environment. Recreating Hands still ends its active PTYs,
browser workers and execution leases; a Gateway reconnect alone does not.
Existing installations may adopt the filesystem owner online through
`scripts/container-deployment/supervise-files.mjs`: the host supervisor verifies
an immutable owner bundle and runs it inside the existing Hands container as its
configured user. It retains the terminal and Native execution connections and
restarts the file owner after a Hands restart. An already healthy integrated
owner takes precedence. Supervised owners close when their private stdin closes.

AppServer and its writable `CODEX_HOME` remain in Brain; the sandbox runner opens
a private authenticated Unix connection and Hands launches only the pinned
`codex exec-server --listen stdio` vector. Hands rejects other commands, paths
outside the mounted workspace, unexpected environment names, stale lease frames
and resource declarations that differ from its verified 4-vCPU/8-GiB/4096-task
cgroup. One connection is one non-replayable execution lease. Disconnect or
owner shutdown terminates the whole process group; an unacknowledged create or
cleanup remains unknown and retains admission capacity. Account, AppServer and
Host databases are not mounted into Hands.

Hands publishes an ephemeral execution-owner incarnation in its private probe.
Brain observes it independently of health checks. After a ready new incarnation
appears, Brain terminates the old Codex AppServer process group and waits for its
exit before starting a replacement, leaving account Core, DSH, Gateway and
persisted threads in place. This is intentional Native connection invalidation:
the shipped Native stdio transport does not reconnect across an executor loss.
A probe timeout alone never authorizes replacing the writer. The old bridge
resolves its process-exit wait on transport loss but keeps cleanup unconfirmed;
it must not release admission capacity or replay any command. On reconnect the
client reconciles persisted thread state; this lifecycle recovery never resends
conversation input or old tool calls.

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
failed destruction and bounded admission.

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
