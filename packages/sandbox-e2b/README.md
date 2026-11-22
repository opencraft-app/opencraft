# Optional E2B execution backend

`@opencraft/sandbox-e2b` implements the existing `SandboxBackend` port using the
pinned E2B JavaScript SDK. It does not add an environment allocator, Bot table,
model gateway, queue or persistent assistant runtime. It is not automatically registered in engine assembly. The optional daemon installation config connects it to managed-Bot execution (see `docs/architecture/identity/managed-bots.md`). Consumers must explicitly install and select this backend.

An installation supplies trusted API/proxy endpoints, one approved template and
a private secret-reader function. User-facing Bot settings must contain only a
provider/template reference, never endpoints, API keys or filesystem paths.

```ts
const backend = e2bSandboxBackend({
  apiUrl: operator.apiUrl,
  sandboxUrl: operator.sandboxUrl,
  templateId: operator.templateId,
  readApiKey: () => operatorSecrets.readE2BKey(),
});
const pool = await createSandboxPool(
  {
    id: "bot-tools",
    capacity: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 },
    defaults: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 },
  },
  backend,
);
const environment = await createSandbox(pool, { owner: executionId });
```

Those example resources require an 8-vCPU/16-GiB template. The normal common
contract default remains 4-vCPU/8-GiB; a different template budget is not silently
accepted. The adapter reads effective CPU/memory from the provider's sandbox-info
API; the shared pool rejects mismatches and destroys the unexposed environment.
This trusts the provider's VM resource enforcement, not a guest `nproc` claim.
Capacity is local to the pool, not account-wide distributed admission.

## Execution and secrets

The template must contain Python 3 at the explicitly configured absolute path
(default `/usr/bin/python3`). A small per-process transport broker preserves
binary stdin/stdout/stderr, literal argv, EOF and exit status over the SDK's text
callbacks. It is not a task scheduler or a business-state owner. Payload argv,
cwd and environment are sent through stdin, not launcher argv. Host environment,
team key, Bot credentials, memory and model configuration are not copied into
the guest. Cwd is an existing path in the remote filesystem; no Host path is
implicitly mounted or transferred. PTY execution supports controlling-terminal setup, initial size, resize and literal input. PTY output is a single terminal stream; non-terminal commands retain separate stdout/stderr and explicit EOF.

The broker uses a process group for explicit process termination. A blocked or
unacknowledged termination fails closed and destroys the whole environment;
whole-environment close is the final descendant boundary, including escaped
process groups. Transport loss never triggers automatic reconnect or replay.
The model/brain must remain with its original owner; this does not make a
loopback model gateway remotely reachable.

## Lifetime and limitations

Create requests carry a stable shared correlation ID in metadata. Unconfirmed
creation is never replayed; common-pool capacity remains reserved for operator
reconciliation. The installation should correlate metadata in provider logs or
its existing execution owner, not create a second assignment registry.

Submitted creation is allowed to return a late ID even after cancellation, so
the shared pool can reclaim it. Close sends deletion and then requires the info
API to report absence before capacity can be returned. A lost delete response
alone is not proof of failed cleanup, nor is a successful delete response alone
proof of absence. Other provider errors retain capacity.

The default instance timeout is five minutes (configurable to one hour). An
installation may supply an owned renewal policy: current Bot authority is checked
before every renewal, with a finite absolute lifetime (maximum 24 hours). The
initial timeout and renewals are bounded by that lifetime. Lost authority, renewal
failure or the deadline retires the instance; it never recreates or replays a
command. Closing cancels renewal and waits for any in-flight renewal before deletion.

There is no memory snapshot, adoption of old instances, filesystem persistence,
or reconnection/replay of live processes. Assistant pause/resume must not be sold
as sandbox persistence. Existing Bot/memory/model owners stay local.

## Verification

`tests/execution/sandbox-e2b.test.ts` covers actual broker pipes against a local
vendor-boundary fixture, binary input, EOF, environment/argv isolation, termination,
resource mismatch, cancellation, unknown creation and unconfirmed deletion.
Shared sandbox lifecycle tests continue to apply.

The tests use an injected vendor boundary and local Python processes with synthetic credentials. They do not establish real-provider compatibility or authorize provisioning. A deployment requires separately authorized provider acceptance.

## Dedicated persistent workspaces

Persistent workspaces require an explicit provider extension, not the standard E2B SDK contract. A trusted installation may supply `readWorkspaceId` from an authorized durable binding. The adapter sends this ID as `metadata.workspace_id`; it does not derive or accept IDs from task input. No volume mounts are sent.
The backend verifies the returned workspace binding before executing commands.
Closing still kills the compute instance; `/workspace` is reused on the next
create and `/shared` remains provider-managed. This is not E2B pause: root-disk
changes and processes are not retained, and no old NFS/process handle is reused.
Existing temporary workspaces are not migrated. Do not clone a deployment identity
into an independent installation or use user-supplied workspace IDs.

The optional read-only inspector requires a schemaVersion 2 workspace/volume API supplied by that extension. It returns unknown on unsupported schemas, authorization loss, changed generations or unconfirmed volumes. An observation is not an allocation lock; creation must still honor the provider occupancy fence. Neither extension is enabled by default.


## Hands image templates

Use the [Hands template build entry](../../docs/hands-e2b-templates.md) to derive
a template from an immutable released Hands image. The build and verification
receipts keep image, template and build identity separate. These operator tools
do not switch the installed catalogue or migrate running environments.

Remote conversation bindings require the preinstalled Hands Codex launcher at
`/opt/opencraft/runtime/codex/bin/codex`. Prepare and verify a compatible template
before upgrading the runner. Missing tools fail startup without downloading,
extracting shared archives or falling back to host execution.
