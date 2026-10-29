# Account environment variables

Implementation status: encrypted management, reusable editor and internal launch
resolution are implemented. Engine and terminal launch adapters are not connected;
this document does not claim runtime injection is available.

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

Launch adapters must pass this snapshot only to the admitted child process. They
must not serialize it into browser RPC, persisted thread configuration, argv,
logs, telemetry or diagnostics. A shared engine process cannot be given one
person's variables globally. Cached workers and native ACP processes must be
bound to an employee/project or replaced by a provider with proven session env
isolation. A generic env merge is not evidence those launch paths are connected.
Existing processes retain their snapshot; changes apply to newly launched
processes, and existing terminals must be reopened.

Application administrators have no API for retrieving secrets. Host root is
outside this boundary: a server that decrypts and injects values cannot hide them
from its privileged host operator. Application permissions also do not establish
an OS sandbox between arbitrary processes sharing a Unix UID. User programs can
print any value they receive; adapter/output observability needs its own checks
before claiming automatic logs cannot contain those values.

The editor consumes shared Settings primitives and host-provided localized
labels, avoiding a second settings or translation owner. The surrounding product
supplies identity, project listing, route registration and localized copy.
