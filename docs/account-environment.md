# Account environment variables

Implementation status: encrypted management, the settings editor and the Codex,
Pi, DSH, ACP and Workbench terminal launch adapters are connected. Independently
installed execution owners must consume this version before their launch adapter
is effective. Installing a gateway does not replace those owners.

An authenticated person owns variables for all of their projects, with optional
Project ID overrides. Project values win by exact name; removing an override
restores the personal default. Identity comes from trusted ingress or execution
admission, never request parameters, display names or a working directory.

`AccountEnvironment` reuses the existing credential vault's private files,
AES-256-GCM with account/namespace AAD, key and managed SQLite lifecycle. Its
versioned document namespace needs no new database migration. Writes use CAS;
deleted documents retain revisions. Secret values are write-only through the
management API: both reads and writes return `null`, and changing a saved secret
to an ordinary value requires explicitly replacing it. Ordinary values are also
encrypted, but remain editable by their owner. No administrator export is exposed.

`AccountEnvironmentHttp` receives an already authenticated account and a live
admission check. It verifies the scope header, same-origin JSON and the project
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
