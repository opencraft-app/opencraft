# Multiple managed Bots and isolated execution

This extends the existing Actor, Bot binding, profile and Host runner. It does not
create another Bot identity registry or execution/environment manager.

## Scope

The Assistants page preserves the default personal assistant and adds a collection
for additional assistants. A Human explicitly creates a named Bot with duties,
opens its native DM, selects its model, browses its private memory, grants its
own bounded Thread profile, and pauses/resumes that exact Bot. Nothing is created
by listing or logging in. One Bot's credentials, memory and model are not reused
as another Bot's identity. A maximum of 32 assignments per Human bounds this entry;
existing Host capacity still bounds runtime admission.

Group invitation continues to use native Actor membership. This first slice does
not add managed-Bot group-message reception or claim that an invited assistant
can already auto-execute every group @mention. That delivery/context work must be
verified separately, not inferred from a member/avatar appearing in the UI.

## Assignment and compatibility

`personal_assistants` remains the assignment owner. The new migration
`0018_multi_bot_assignments` adds defaults/configuration fields and replaces the
old owner-unique index with an owner-unique partial index for `is_default=1`.
There is no table recreation, historical migration edit, identity copy, credential
copy or memory move. Existing botId, actorId, assignmentId, epoch, model selection,
private channels and delegated profiles are preserved. A fixture checks old data,
foreign keys and migration reopening.

Existing owner methods without `botId` select the explicit default. Owner-facing
methods with `botId` select only an owned assignment. Internal Host provision also
passes the explicit Bot ID, including credential renewal. Memory validates the
Bot, assignment and epoch on both sides of asynchronous reads. Thread grants are
per Bot; old callers without a target still address the default.

Owned assignments remain visible after an owner authority-generation change, but
are projected as stopped/revoked and cannot provision. Only an explicit resume by
the current authenticated owner reclaims that same assignment, increments its
configuration revision and rotates its authority; listing never reclaims it.

Creation uses an owner-scoped idempotency key and payload fingerprint. Updates and
pause use config revision CAS. Configuration changes retire previous authority;
old active credentials are invalidated both in storage and the connection owner's
read projection. Display-name receipts update display metadata only, never Actor
generation or grants. Input-projection invalidation targets the selected Bot,
not every Bot belonging to the same Human. The settings dialog discloses that
saving restarts that assistant and requires renewed task authorization; history
and memory remain. This is not transparent migration of an in-flight task.

## Environment boundary

The selected value is either `{kind:'local'}` or an opaque
`{kind:'sandbox',backendId,templateId}` reference. It is not an API key, public URL,
filesystem path, runtime lease, or resource-access grant. Local means the existing
assistant execution Host, never the browser/phone displaying the page.

The installation exposes only registered providers with a real execution adapter;
the Host validates the template before persistence and again before launch.
Backend-neutral sandbox lifecycle/admission remains `createSandboxPool()` /
`createSandbox()` in `packages/sandbox`, with node provider assembly under
`packages/sandbox-node`. Do not implement a second environment allocator in IM
or in a Bot settings component. An adapter must implement explicit remote workspace semantics, process
transport, resource budgets, bounded lifetime and confirmed cleanup. This slice
supports ephemeral workspaces only; it does not claim disk restoration.

The optional `@opencraft/sandbox-e2b` backend implements that contract. Daemon
assembly registers the provider only when `OPENCRAFT_ASSISTANT_SANDBOX_CONFIG`
points to a valid installation-owned private JSON file. Both that file and its
`apiKeyFile` must be absolute, owned by the current process user, regular files,
not final-component symlinks, with no group/other permissions (use 0600). Missing
configuration hides E2B. Invalid optional configuration logs a safe constant and
disables this capability without preventing Core startup. A saved unsupported
selection fails closed, never launches locally as a fallback.

Example operator configuration (all endpoints/template IDs are operator inputs,
not user Bot settings; provision the key separately, never commit it):

```json
{
  "schemaVersion": 1,
  "backend": "e2b",
  "apiUrl": "https://sandbox-api.example.com",
  "sandboxUrl": "https://sandbox-proxy.example.com",
  "apiKeyFile": "/run/secrets/assistant-e2b-key",
  "capacity": { "cpuMillis": 16000, "memoryBytes": 34359738368 },
  "templates": [
    {
      "id": "operator-approved-template",
      "name": "Development tools",
      "resources": { "cpuMillis": 8000, "memoryBytes": 17179869184 },
      "workspaceRoot": "/home/user/opencraft-bot-workspaces",
      "python": "/usr/bin/python3"
    }
  ],
  "lease": {
    "timeoutMs": 300000,
    "renewEveryMs": 60000,
    "maxLifetimeMs": 3600000
  },
  "maxCommandMs": 60000
}
```

Capacity is shared across this provider's templates in one Host pool, not an
account-wide distributed quota. Templates must supply the configured resources
and Python 3. No sandbox is allocated merely by listing or creating a Bot.

The assistant brain, identity, persistent memory, task ledger and model gateway
stay local. Only new delegations that capture the current isolated environment
binding receive the Codex-only `environment_run` tool. Existing local/Pi profiles
and old captured delegations do not gain shell access. Parameters are literal
argv, a workspace-relative cwd and a bounded timeout; no Host paths are mounted
and no Host environment/model/Bot/team credentials are copied. One command per
Bot is admitted; stdout/stderr are bounded with full-stream hashes. Timeout stops
the process but does not roll back effects.

The private parent-child bridge checks Bot assignment/epoch before and after
execution and during commands; renewals check the same Core authority. Pause,
configuration change, authority loss, shutdown or absolute lease expiry retires
the selected environment. Workspaces are ephemeral. A restarted brain receives a
new binding and cannot silently adopt the old workspace. History/memory remain.

`environment_run` is non-idempotent (`replay: once`). Its outcome is owned by the
existing native tool receipt: known completions may return the same bounded
receipt after authorization; an interrupted/unknown effect stays pending and
halts the native turn instead of being returned as a retryable tool error.
Restart does not execute it again. Explicit reconciliation/new authorized work
is required. No generic public shell API, new job queue or second receipt table
is added. Unconfirmed VM create/delete retains admission; a safe operator warning
contains only backend, random owner and shared correlation ID (when available),
which match provider metadata. Resolve it through provider logs/API before
restarting the Host; process-local admission is not durable orphan reconciliation.

## Validation and rollout

Focused tests cover multiple owned Bots, default compatibility, unauthorized
selectors, create retry, CAS, credential retirement, independent pause, explicit
Host provisioning, environment rejection, private memory and old-data migration.
A real pinned Codex fixture uses two isolated processes and controlled loopback
Responses streams to verify different models reply into different native DMs.
This does not call a paid external model or use real users. Full managed-Bot
sandbox fixtures also cover lazy allocation, independent placements, revocation,
unknown creation, timeout, lost effect acknowledgements and non-replay after
restart. Authorized real E2B acceptance completed a native Bot command/reply,
three renewals, and confirmed pause cleanup.

The Web smoke uses the real Shell/route, shared settings/modal components and a
synthetic RPC. It covers mouse/touch and light/dark creation, failure retry with
the same request ID, target-specific pause/settings, unsupported E2B hiding and
long-name layout, approved E2B selection and the ephemeral-workspace warning. Shared stacked settings rows avoid squeezed phone forms.

This change includes an incremental Server migration and runtime/protocol work.
Do not deploy it as only a frontend or an arbitrary single-bundle overlay. Preserve
the locked source inputs, back up the exact persistent database, ship matched
owners and verify old-client/default-assistant behavior and restart recovery.
No production deployment is implied by source tests or the provider port.
