# Assets-owned workspaces and resource budgets

## Ownership and current implementation

Workspace configuration, physical provider environments, native Thread placement,
resource admission and filesystem access are separate facts. A saved E2B
connection is not proof that an engine can execute in it. Human/instance authority
must authorize the original operation before any allocation; budget availability
never grants that authority.

The Assets configuration Worker is the sole writer of the existing encrypted
vault. `WorkspaceBudgetStore` records an installed outer admission budget in that
same vault; Main and provider adapters use the asynchronous `WorkspaceBudgetPort`.
There is no additional writable vault, budget database, public HTTP mutation or
implicit provisioning at startup. The installed policy supplies capacity; an
unconfigured installation refuses allocation instead of inventing a host budget.

`withWorkspaceBudget()` wraps the existing `SandboxBackend` lifecycle. It reserves
CPU/memory before calling the provider, shares installed capacity between Bot and
ordinary-conversation pools, and preserves the backend's effective resources and
process limits. Kernel/provider enforcement remains the backend's responsibility;
this ledger is not a filesystem/network sandbox or proof of physical constraints.

## Failure and lifetime rules

- Only explicit non-creation or confirmed environment destruction releases a
  reservation. Command completion, backend close, transport loss and Worker restart
  do not prove either and do not free installed capacity.
- Unknown creation and failed destruction remain charged. Mutations and possibly
  committed provider requests are never automatically replayed.
- Cancellation before reservation performs no allocation. Cancellation after a
  confirmed reservation but before the provider call releases that reservation.
  A lost reservation acknowledgement never calls the provider, but a possibly
  committed reservation remains charged for explicit reconciliation.
- Each new reservation has a fresh opaque settlement receipt. An old receipt
  cannot release a later environment reusing the same logical identity. Repeated
  `close()` shares its original promise and never repeats destruction/settlement.
- Existing legacy records without a fresh receipt remain charged. Identity hashes
  alone cannot authorize their release. Missing/corrupt state fails closed; no
  automatic migration resets consumption or assumes a remote environment is gone.

The Worker serializes all budget mutations, including writes while a provider
request is pending outside the Worker. Its existing grant-read lane does not make
budget writes concurrent or keep a transaction open across network awaits.

## Installed delivery and immutable catalog

A trusted compiled caller may pass `installationFile` to the Assets owner. The
Worker validates private regular files, refuses symlinks/foreign ownership or
broad permissions, reads the bounded installation/key files, and atomically
adopts the existing configuration schema. No provider is registered or provisioned
by this bootstrap and no API key is returned. Once adopted, the encrypted document
is canonical: absent legacy files or a deleted environment never recreate it.

`InstalledWorkspaceCatalog` resolves configured platform environments for an
admitted Human Actor. Public projections include only logical targets, names and
requested resources; provider URLs, key bytes, mount volumes and runtime paths
stay private. Its revision pins the template, credential generation and installed
resource/lease policy. Validation of an old revision rejects rather than silently
switching it to replacement credentials or a different resource budget.

The existing canonical selection encoding now lives in the shared execution
environment package, with a compatibility export at the native Host's old entry.
It preserves the original digest and durable selection format. Native receipt
and placement authority are not inferred from a catalog selection.

This is an explicit owner bootstrap, not automatic default Headless activation.
The default execution assembly must still adopt it together with its native and
provider owners, rather than keep an independent file-backed provider alongside
the vault-backed configuration.

## Evidence and remaining integration

`tests/extensions/workspace-budget.test.ts` exercises the real Assets Worker with
synthetic provider handles, including shared capacity, restart, uncertain create,
failed/pending cleanup, late settlement, cancellation and lost acknowledgements.
The existing packaged-owner test checks the compiled sibling Worker without a
source-tree fallback. These are not live cloud or container acceptance tests.

The budget and Worker lifecycle below are implemented candidates, not completed
default workspace execution. Remaining integration must connect the default
Native hooks and workspace file/artifact/terminal/browser bridges to those owners.
That integration must preserve original
Human/Actor epochs, never infer local execution from a missing remote binding,
and keep actual provider credentials inside their trusted execution owner.
Do not advertise a new workspace capability solely because this ledger exists.

The general execution primitive and actual resource enforcement boundaries are
specified in [execution sandbox](execution-sandbox.md); native lifetime and
transport ownership are specified in [execution ownership](execution-ownership.md).

### Worker lifecycle candidate

The compiled Headless Assets Worker now accepts the private `workspaceMachineId`
composition option. It opens the existing ordinary-workspace journal and its
single process-writer lock; the generic configuration Worker refuses this option
rather than claiming execution support. This does not enable the default Host
catalog or allocate provider resources at startup.

The workspace owner resolves the canonical catalog and Git/library selections,
charges the installed global budget, verifies actual mounts, and uses the existing
conversation binding. Native preparation is a bounded opaque attempt: Worker
returns a private execution selection, while the actual Native reply is a separate
receipt. The Worker records a positive Thread identity before rechecking whether
publication is still authorized. Cancellation retains unresolved creation evidence;
unconfirmed cleanup remains charged across replacement. A live workspace resume
still waits for a real matching Native resume, without allocating again.

The attachment-local Native handoff is a narrow Worker client, not another journal
or writable vault. It retains cancelled reply slots for late positive receipts,
checks the original trusted context, refreshes committed placement even when
publication fails, and never retries Native creation. Human admission comes from
the existing Actor/member owners, with separate request and resource permits.
Closing a View cannot revoke published compute; Actor/member revocation is
monotonic and is independently rechecked from existing storage inside the Worker.

`tests/server/assets-workspace-execution.test.ts` exercises the real Worker,
conversation owner, journal, budget and handoff with synthetic provider/binding
handles. The packaging test also opens the bundled Headless Worker and private
journal without importing source-tree code or a local PTY provider. Neither test
is evidence of real cloud provisioning, an official exec-server handshake, or
four-role container resource enforcement.

Default Headless Native hook composition and source-aware placement
reconciliation remain integration work in the same workspace change; the Worker
file/artifact/terminal/browser bridges are implemented below. Keep the default capability unpublished until that
composition is complete; do not run a second legacy file-backed provider beside
the adopted vault-backed installation.

### Gateway Native and file composition candidate

`openWorkspaceExecutionService` composes an already owned Assets Worker with the
existing private one-shot Core authority. It does not open another store or
allocate compute. Each physical Native attachment gets its own bounded handoff;
creation and restoration wait for the actual identity receipt before refreshing
committed placement. Provisional empty Threads require the adapter's existing
fresh Native confirmation, not replayed creation. Scoped file requests resolve a
live Worker binding, pin its generation and propagate cancellation independently
of the resource lifetime. A missing remote file binding never selects Host files.

The synchronous placement projection is initialized from complete Worker pages,
including retained idle Threads. Refresh failure fences classification instead
of replacing it with an empty local-looking map. Actual private Native metadata
can also establish a remote selection before a Worker receipt exists. That
read-only remote observation survives a journal refresh; it is not another
writable identity ledger or authorization grant. Local file scope requires an
explicit Native `opencraft` selection, not an absent workspace row or cached cwd;
physical reconnect withdraws those local observations.

When the matched private workspace policy is installed, Core independently reads
Native's own current `Thread.environments` before accepting local turns or forks.
A remote, missing, empty, mixed, or unavailable selection is not local execution
proof, even if the caller supplies a local cwd. An unloaded rollout can only be
resumed without cwd/environment/root overrides to discover its Native selection;
it still cannot execute locally until the selection is explicitly confirmed.
Logical `workspacePlacement` and the private grant are removed before Native.
Legacy template IDs that cannot satisfy the logical target contract remain
editable in Assets but are not advertised as executable workspace choices.

The physical routing tests exercise Worker preparation, actual private ticket
consumption, Core policy, receipt barriers, duplicate suppression, source-aware
placement and scoped files. Providers and Native replies in those tests remain
synthetic. The default Headless startup still needs the matching Native service
installation, remaining artifact/terminal/browser ports and a single Bot/provider
configuration owner; this candidate does not publish default workspace capability.

### Artifact and terminal transport candidate

Workspace artifacts now cross the Worker boundary through bounded private credits,
not raw provider handles, executable callbacks or a Host path to open inside the
Worker. The trusted local artifact owner reads upload bytes; Worker receives only
metadata and at most 64 KiB per credit, writes to the private working volume, and
waits for the remote size/hash/atomic-rename receipt. Downloads retain the existing
scoped, symlink-refusing reader and its final digest receipt. Repeated credits do
not advance the source or write bytes twice. Transfers are bounded to 16 handles,
1 GiB each and 30 seconds without a consumer heartbeat. Helpers run Python in
isolated mode so user files in the workspace cannot replace their stdlib imports.

Opening, reading, writing, finishing and closing are short RPC state transitions.
Their provider/stream jobs run with the existing owner outside the FIFO lane; a
provider waiting for upload input cannot block Actor, budget or catalog calls.
Request revocation aborts only that transfer, and cleanup remains pending/failed
until the actual owner confirms it. Closing a transfer never refunds workspace
capacity or destroys the separately published Native resource.

Terminal transport reuses the bound `SandboxProcessService`, including its
existing process limits and bounded output replay. Worker operations have private
one-shot correlation and are not resubmitted on timeout. A stable Gateway proxy
belongs to one Actor/Thread/incarnation; each dispatch separately receives the
original trusted ingress, not the first request or last subscriber. Resource
watches survive View/request expiry, while each actual mutation rechecks fresh
Actor/member and request authority. Output forwarding still passes through the
existing per-client terminal authorization. Proxy/watch detach does not kill
processes; binding or resource shutdown belongs to their existing owner.

The transport tests use real Worker/journal/budget owners and real scoped Python
artifact helpers in a temporary synthetic workspace. PTY/provider handles are
synthetic, not evidence of an E2B connection or kernel enforcement. The bridge
retains per-binding limits; the shared Hands admission owner described below
supplies aggregate terminal admission, not this transport itself. Browser ports
and default Bot/provider composition are implemented below. Default ordinary
Headless Native activation remains unfinished.

### Browser transport candidate

The Gateway composition now routes the existing central browser service through
the same Worker-owned execution binding. Page selection comes from committed
page/conversation links or a committed close receipt, not renderer-supplied
workspace/socket identity. A remote or unclassified conversation cannot choose
the local browser. The central service remains the sole page/capacity store;
one resource-owned Browser Owner and attachment are shared by the admitted tabs
of a compute incarnation.

Browser IPC uses bounded opaque channels and explicit read/write credits rather
than moving SDK handles or secrets to Main. Long attachment/flush work runs
outside FIFO RPC. Incoming queues are capped at 64 frames/32 MiB per channel and
64 MiB overall; outgoing messages retain the existing 256 KiB limit and bounded
pending writes. Overflow or uncertain transport loss retires the channel without
silently dropping results or replaying commands. Detach closes the IPC proxy,
not the independent resource-owned browser process. Actor/member epochs,
incarnation and canonical configuration are rechecked before frames are handed
to Main; each central page retains its own fresh authorization guard.

Resolving durable browser resources now has a real asynchronous Worker boundary.
If a page closes or retires while that lookup is pending, the request has not yet
reached a peer. Its preparation is rejected as `not-dispatched`, without poisoning
another page's admitted close or the whole shared owner. This does not refresh a
captured stale guard, weaken page authorization, replay a write, or turn an
uncertain attachment failure into a non-delivery claim. Proxy startup uses
isolated Python so workspace modules cannot replace the standard IPC imports.

Tests exercise the actual Worker and central SQLite-backed browser service,
shared tabs, committed close routing, old-epoch rejection, resource revocation,
queue overflow, pending cleanup and no local fallback. The Browser Owner in these
cases is synthetic; no Chromium process/cloud VM or visual media rendering is
proved by those tests. Bot/provider unification, shared terminal admission and the
matching default Headless startup are still required before default activation.

### Bot execution in the same Worker

The default unmanaged Headless composition now opens one compiled Assets Worker,
even if no login page or installation file is configured. Human Assets HTTP and
Bot execution share that owner. An optional private delivery file is imported
inside Worker; after adoption, the encrypted installation is authoritative even
when that file is removed or its environment variable is unset. A failed initial
optional import advertises no remote Bot templates and never starts a second
file-backed provider. Private identity compositions that explicitly own their
configuration remain mutually exclusive.

`WorkspaceBotOwner` owns the existing sandbox assistant provider, provider SDK,
commands and pool, wrapped with the same durable outer budget as ordinary
workspaces. The assistant brain, profile, model gateway and task ledger stay
local. No profile/model credentials, local brain directory, provider key or SDK
handle crosses this execution channel. Reverse callbacks invoke only the original
Bot assignment authorization; binding and epoch checks stay in the existing
provider. Catalogs are secret-free, allocation is lazy, and provider/configuration
revision replacement cannot silently redirect an admitted resource.

Long execution and reverse authorization never occupy the FIFO RPC lane. Opaque
one-shot jobs are bounded; source failure cannot replay a command. Close retires
callback tokens before cleanup; an unresponsive original authorization cannot
block resource retirement. Unknown creation/deletion remains charged across
Worker replacement. Confirmed destruction alone releases that reservation.
Closing Main observation does not count as destruction. This is implemented
source/default Bot assembly, not live cloud, model or container acceptance.
Default ordinary Native assembly remains unfinished in this workspace batch;
shared local/remote terminal admission is described below.

### One admission owner for local and remote UI terminals

CPU/memory environment capacity remains in the Assets vault; UI terminal counts
are owned by the existing independent Hands PTY owner. These are different
resources. Its private `TerminalAdmissionStore` now arbitrates both local PTY
starts and remote SDK terminals: 16 active terminals per Actor/Host key and 64
across that owner. Existing per-binding/process-service limits are additional
bounds, not separate sources of installation-wide capacity.

The private journal belongs to one subordinate storage Worker in the existing
Hands owner. Its permanent kernel writer lock cannot expire while Hands is paused;
the network/PTY IPC loop performs no synchronous store IO. The packaged and
retained runtime includes that exact companion Worker, with integrity hashing. A reservation is durably committed before physical spawn. Each settlement
uses a fresh nonce; duplicate/stale releases cannot free a later incarnation.
Malformed/non-private state fails closed without replacement. A known validation
failure before local spawn releases its reservation; an entered spawn with unknown
outcome does not. Normal PTY exit is positive terminal-process evidence, not a
claim that all environment tasks or descendants are gone. Existing independent
owner shutdown still drains its process sessions.

`withRemoteTerminalAdmission` uses only compiled private Hands IPC. SDK creation
runs in Worker, rechecks resource authorization after asynchronous admission, and
never retries an uncertain spawn. Only actual child exit or confirmed destruction
of the exact workspace generation/instance releases its terminal count; kill
acknowledgement, View detach, a lost reserve reply and either owner's restart do
not. Confirmed full resource deletion can settle a lost reservation reply by the
same exact resource identity. Uncertain rows stay charged, including after owner
replacement; this deliberately favors capacity safety over automatic recovery.
Unproven old local reservations are not reset just because inventory is empty.

Private quota methods are excluded from the public process catalog. A legacy
Hands owner without the admission capability is not treated as equivalent. No
configured admission means remote terminals are unavailable, not routed to a
controller PTY; nonterminal execution is unchanged. Default ordinary Native
startup must pass the same trusted Hands endpoint/token-file location into the
already-owned Assets Worker. This source plumbing is implemented, but that default
ordinary startup remains unfinished in this batch.

Tests exercise the real private Hands socket/journal and real local PTYs alongside
synthetic remote SDK processes, including aggregate/account limits, nonce ABA,
lost replies, unknown SDK spawn, owner replacement and Worker-to-Hands routing.
They do not prove real cloud PTY behavior, systemd acceptance or four-role limits.
