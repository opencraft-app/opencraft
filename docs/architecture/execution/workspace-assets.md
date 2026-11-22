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

Default Headless Native hook composition, source-aware placement reconciliation,
and the Worker file/artifact/terminal/browser bridges remain integration work in
the same workspace change. Keep the default capability unpublished until that
composition is complete; do not run a second legacy file-backed provider beside
the adopted vault-backed installation.
