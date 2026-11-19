# Optional E2B execution backend

`@opencraft/sandbox-e2b` implements the existing `SandboxBackend` port using the
pinned E2B JavaScript SDK. It does not add an environment allocator, Bot table,
model gateway, queue or persistent assistant runtime. It is not automatically registered in engine assembly. The optional daemon
installation config connects it to managed-Bot execution (see `docs/managed-bots.md`).

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
implicitly mounted or transferred. Terminal support is deliberately false.

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

A separately authorized real-provider probe exercised both operator templates
through **createSandbox**, checked actual provider-reported resources, binary
stdin/output/EOF, multiple process transport, official Codex 0.162.1 exec-server
initialization, and confirmed destruction. This is execution-provider evidence,
not an automatic production rollout. A subsequent authorized acceptance test also
exercised native DM -> Bot -> captured Work -> actual E2B command -> native DM,
three real renewals, and confirmed deletion after pause, using a synthetic local
model. No external paid model, production users or persistent guest credentials
were involved.

## Dedicated persistent workspaces

Trusted assistant installations may opt into `persistentWorkspaces: true` with
all template `workspaceRoot` values set to `/workspace`. The authorized Server,
Bot and owner binding deterministically derives `metadata.workspace_id`; lease
epochs and execution incarnations never participate. No volume mounts are sent.
The backend verifies the returned workspace binding before executing commands.
Closing still kills the compute instance; `/workspace` is reused on the next
create and `/shared` remains provider-managed. This is not E2B pause: root-disk
changes and processes are not retained, and no old NFS/process handle is reused.
Existing temporary workspaces are not migrated. Do not clone a deployment identity
into an independent installation or use user-supplied workspace IDs.
