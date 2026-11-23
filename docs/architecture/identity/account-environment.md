# Account environment variables

Implementation status: encrypted management, the settings editor and the Codex,
Pi, DSH, ACP and Workbench terminal launch adapters are connected. Independently
installed execution owners must consume this version before their launch adapter
is effective. Installing a gateway does not replace those owners.
Independent owners initialize their private ENV store when they start, so an
owner started before the identity gateway observes subsequently saved values.

Headless and Electron package the DSH capability resource as a bundled module;
its credential runtime must not depend on source files or a parent TS loader.

An authenticated person owns variables for all of their projects, with optional
Project ID overrides. Project values win by exact name; removing an override
restores the personal default. Identity comes from trusted ingress or execution
admission, never request parameters, display names or a working directory.

New tasks retain an immutable creation account reference established before the
successful creation result is published. It is provenance, not execution authority.
Thread/Actor access checks still authorize participation. Every newly started Turn,
including a shared participant's queued input, uses its own authenticated account
and current personal/project variables; steering retains the active Turn's environment. A viewer cannot borrow the creator's values
or rewrite creation provenance. Durable queued execution and recovery retain the
original input principal; an unadmitted recovery read receives no personal values.
Anonymous participation in an account-owned task is refused. A later authenticated
participant in an anonymously created task uses their own values without claiming
the creation record. Forks bind the copying person's account and replace native
environment overlays, including an empty overlay. Existing processes keep their
original environment and owner checks; new launches use current saved values.
Before an empty task's first input, a different admitted sender causes the normal
native unload/resume path to replace the creation environment and session tools.
Creation provenance remains unchanged, including after Host state restoration.
A restored creation record is never proof of the currently installed native
environment; reconnect and failed-handoff paths refresh it before sending.
Authorized shared participants may steer the exact native active Turn without
changing its execution environment, account or session tools. The input-control
policy is explicit in trusted composition, never inferred from an ENV cache. Such steering can
influence work running with that Turn's existing credentials; shared participation
therefore intentionally delegates this input control, not terminal access or
credential disclosure. Shell/settings/review retain current-environment owner checks.
Participants may edit ordinary queued input; its original captured execution principal
and sender attribution remain unchanged, including after durable recovery. Managed
Actor inputs stay immutable and require their existing trusted admission.
Private-thread access, expired identities, exact-Turn checks, unknown delivery and
unconfirmed-environment fences remain enforced.
Native configuration changes revoke the previous environment-owner confirmation
before mutation; failure keeps controls fenced until the entire restoration commits.

Failures detected before forwarding produce a correlated native RPC rejection
with `notSubmitted: true`, `submissionOutcome: rejected` and `retryable: false`.
A delivery failure after forwarding retains unknown-outcome semantics; it is never
automatically replayed or represented as a confirmed rejection.

`AccountEnvironment` reuses the existing credential vault's private files,
AES-256-GCM with account/namespace AAD, key and managed SQLite lifecycle. Its
versioned document namespace needs no new database migration. Writes use CAS;
deleted documents retain revisions. Secret values are write-only through the
management API: both reads and writes return `null`, and changing a saved secret
to an ordinary value requires explicitly replacing it. Ordinary values are also
encrypted, but remain editable by their owner. No administrator export is exposed.

`AccountEnvironmentHttp` receives an already authenticated account and a live
admission check. Core serves it at `/__opencraft_assets/environment` through
`openIdentityAssets` for any verified principal: the account is the Human proof's
`actor:<actorId>` scope, and the vault Worker's `environmentList`,
`environmentReplace` and `environmentProjects` recheck that proof against committed
Actor/member records before reading or writing, so Main never holds a value or
chooses a partition
([Assets catalog](../extensions/assets-catalog.md#personal-env)). It verifies the scope header, same-origin JSON and the project
catalog, rechecks identity after asynchronous work, bounds input and returns
stable error codes. It never returns raw exception messages or environment
snapshots. Hosts must not add request-body logging to this route. The editor
keeps drafts in memory and cancels obsolete account/project requests.

`launchEnvironment` is an internal, trusted launch port. Callers must establish
both the employee and durable Project ID before using it. It produces a new env
object, leaving shared `process.env` and platform variables unchanged. Reserved
names cover identity, authentication, proxies, home/path, loader and shell hooks,
and platform/engine namespaces. An existing platform value also refuses an
otherwise unknown conflicting name at launch.

Launch adapters resolve only trusted execution provenance. The gateway binds a
thread to its durable Host/Project ID and uses the credential vault to authenticate
short-lived scope envelopes for independent ACP creation. Browser-provided
identity/envelopes are removed. Recovery and tools read the original admitted
execution lease, never the most recent viewer or a working directory.

| Execution boundary | Injection |
| --- | --- |
| Codex | Private, in-memory `shell_environment_policy.set` on native thread/start and resume. Native TurnContext/rollout does not persist this policy; the native-shell smoke also scans the resulting files. The first unpersisted turn retains its creation snapshot. Later idle turns refresh the native runtime when identity or values change. Independent Core requires an attested environment capability; generation routing checks the actual thread's pinned generation. |
| Pi | A shell worker belongs to one employee/project/value snapshot. New launches select the current snapshot; existing shell handles retain their worker and reject another owner. Native NodeExecutionEnv uses the same admitted scope. |
| DSH | The logical/native thread resolver supplies a private environment port at both LocalBashExecutor.spawnSpec and terminal childEnvironment. The DSH_* declaration registry contains only its declared thread marker; business values do not enter it. |
| ACP | Each session owns a native transport, with values supplied only to spawn's env. Saved routing/session JSON has no values. An existing session keeps its environment until reopened; switching employee or project requires a new session. Handoff occupancy includes every native PID and pending call. |
| Workbench terminal | The trusted gateway supplies HostProcessService with an authenticated account/project scope. All attach/control/list requests use the terminal's original thread scope; another employee or project cannot retrieve/control it. Scope-specific notifications retain logical-client identity and admission lifetime. |

Before the first accepted Turn, the creation record persists only the account,
Host and Project owner fingerprint, alongside the provisional routing evidence.
After a Host replacement, the same admitted owner can bind the restored MCP
reservation and use the native creation environment without resuming nonexistent
history. A changed or unknown owner refuses input before any credential binding
or native dispatch. The stored fingerprint contains no variable values or applied
configuration key; later idle executions still refresh the current environment.
Version 1 creation records migrate with unknown ownership rather than inferring
it from the current viewer.

Values never enter argv, browser configuration, shared process.env or diagnostic
payloads. Native stderr is consumed privately rather than forwarded into platform
logs; adapter diagnostics redact live snapshots and native ACP errors omit private
data. Intentional command output remains visible to its admitted user. New
processes see saved changes; running shells keep their original environment.
Existing Workbench terminals must be closed and reopened. ACP sessions must be
reopened. Page reconnection alone does not refresh a process.

Application administrators have no API for retrieving secrets. Host root is
outside this boundary: a server that decrypts and injects values cannot hide them
from its privileged host operator. Application permissions also do not establish
an OS sandbox between arbitrary processes sharing a Unix UID. User programs can
print any value they receive; platform diagnostics must never record environment snapshots or raw native stderr.

The editor consumes shared Settings primitives and host-provided localized
labels, avoiding a second settings or translation owner. The surrounding product
supplies identity, project listing, route registration and localized copy.


Pre-dispatch environment authority rejection returns a correlated JSON-RPC error
with `notSubmitted: true`, `submissionOutcome: rejected` and `retryable: false`.
It is not a reconnect instruction or an automatic-replay grant. This result is
emitted only before native dispatch; later delivery errors keep their existing
unknown-outcome semantics. Private authority errors and request payloads are not
reflected. Notifications produce no response. This changes no creator, shared
conversation, steering, queue or credential authorization policy; those guards
remain in force. Gateway-only installation does not update independent owners.


## Opaque launch delivery

Moving decrypted values out of Main into a single vault owner is specified in
[execution ENV launch delivery](../execution/environment-launch-delivery.md).

## Operation effects, native control and execution provenance

See [execution control](../execution/execution-control-authority.md). Goal intent, queue
editing and active-Turn input are not admissions to personal credentials.
An absent ENV cache after Gateway restart does not prove a different account.
Automatic native continuations whose provenance is unknown stay unknown.
